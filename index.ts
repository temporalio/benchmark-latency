import * as pulumi from "@pulumi/pulumi";

import * as aws from "@pulumi/aws";
import * as gcp from "@pulumi/gcp";
import * as eks from "@pulumi/eks";
import * as azuread from "@pulumi/azuread";
import * as resources from "@pulumi/azure-native/resources";
import * as containerservice from "@pulumi/azure-native/containerservice";

import * as k8s from "@pulumi/kubernetes";
import * as types from './config';

import * as omes from './omes';

import { dump } from 'js-yaml';
import dedent from 'dedent';
import { merge } from 'ts-deepmerge';

let config = new pulumi.Config();
const temporalConfig = config.requireObject<types.TemporalConfig>('Temporal');

function createCluster(name: string, config: types.KubernetesConfig): Cluster {
    if (config.AWS) {
        return eksCluster(name, config)
    } else if (config.GCP) {
        return gksCluster(name, config)
    } else if (config.Azure) {
        return aksCluster(name, config)
    }

    throw("unknown cluster configuration")
}

interface Cluster {
    Provider: k8s.Provider
    Kubeconfig: pulumi.Output<any>
    SecurityGroup?: pulumi.Output<string>
}

function eksCluster(name: string, config: types.KubernetesConfig): Cluster {
    if (config.AWS == undefined) {
        throw("eksCluster needs AWS configuration")
    }

    const identity = aws.getCallerIdentity({});
    const role = pulumi.concat('arn:aws:iam::', identity.then(current => current.accountId), ':role/', config.AWS.Role);

    const kubeconfigOptions: eks.KubeconfigOptions = { roleArn: role }

    const cluster = new eks.Cluster(name, {
        name: name,
        providerCredentialOpts: kubeconfigOptions,
        vpcId: config.AWS.VpcId,
        publicSubnetIds: config.AWS.PublicSubnetIds,
        privateSubnetIds: config.AWS.PrivateSubnetIds,
        nodeAssociatePublicIpAddress: false,
        instanceType: config.NodeType,
        desiredCapacity: config.NodeCount,
        minSize: config.NodeCount,
        maxSize: config.NodeCount,
    });

    if (temporalConfig.SelfHosted) {
        cluster.createNodeGroup(`${name}-temporal`, {
            instanceType: "m5.2xlarge",
            desiredCapacity: 1,
            minSize: 1,
            maxSize: 1,
            labels: {
                dedicated: "temporal",
            },
            taints: {
                "dedicated": { value: "temporal", effect: "NoSchedule" }
            }
        })    
    }

    return {
        Provider: cluster.provider,
        Kubeconfig: cluster.kubeconfig.apply((kc) => dump(kc)),
        SecurityGroup: cluster.nodeSecurityGroup.id,
    }
}

function gksCluster(name: string, config: types.KubernetesConfig): Cluster {
    const engineVersion = gcp.container.getEngineVersions().then(v => v.latestMasterVersion);

    const cluster = new gcp.container.Cluster(name, {
        initialNodeCount: config.NodeCount,
        name: name,
        minMasterVersion: engineVersion,
        deletionProtection: false,
        nodeVersion: engineVersion,
        nodeConfig: {
            machineType: config.NodeType,
            oauthScopes: [
                "https://www.googleapis.com/auth/compute",
                "https://www.googleapis.com/auth/devstorage.read_only",
                "https://www.googleapis.com/auth/logging.write",
                "https://www.googleapis.com/auth/monitoring"
            ],
        },
    });

    const kubeconfig = pulumi.
        all([ cluster.name, cluster.endpoint, cluster.masterAuth ]).
        apply(([ name, endpoint, masterAuth ]) => {
            const context = `gke_${gcp.config.project}_${gcp.config.zone}_${name}`;
            return dedent(`
                apiVersion: v1
                clusters:
                - name: ${context}
                  cluster:
                    certificate-authority-data: ${masterAuth.clusterCaCertificate}
                    server: https://${endpoint}
                contexts:
                - name: ${context}
                  context:
                    cluster: ${context}
                    user: ${context}
                current-context: ${context}
                kind: Config
                preferences: {}
                users:
                - name: ${context}
                  user:
                    exec:
                    apiVersion: client.authentication.k8s.io/v1beta1
                    command: gke-gcloud-auth-plugin
                    installHint: Install gke-gcloud-auth-plugin for use with kubectl by following
                        https://cloud.google.com/blog/products/containers-kubernetes/kubectl-auth-changes-in-gke
                    provideClusterInfo: true
            `)
        });

    return {
        Provider: new k8s.Provider(name, { kubeconfig: kubeconfig }),
        Kubeconfig: kubeconfig,
    }
}

function aksCluster(name: string, config: types.KubernetesConfig): Cluster {
    const resourceGroup = new resources.ResourceGroup(name);
    const adApp = new azuread.Application(name, {
        displayName: name,
    });
    const adSp = new azuread.ServicePrincipal(name, {
        clientId: adApp.clientId,
    });
    const adSpPassword = new azuread.ServicePrincipalPassword(name, {
        servicePrincipalId: adSp.id,
        endDate: "2099-01-01T00:00:00Z",
    });
    const cluster = new containerservice.ManagedCluster(name, {
        resourceGroupName: resourceGroup.name,
        agentPoolProfiles: [{
            count: config.NodeCount,
            mode: "System",
            name: "agentpool",
            osDiskSizeGB: 30,
            osType: "Linux",
            type: "VirtualMachineScaleSets",
            vmSize: config.NodeType,
        }],
        enableRBAC: true,
        dnsPrefix: name,
        nodeResourceGroup: name,
        servicePrincipalProfile: {
            clientId: adApp.clientId,
            secret: adSpPassword.value,
        },
    });

    const creds = containerservice.listManagedClusterUserCredentialsOutput({
        resourceGroupName: resourceGroup.name,
        resourceName: cluster.name,
    });

    const encoded = creds.kubeconfigs[0].value;
    const kubeconfig = pulumi.secret(encoded.apply(enc => Buffer.from(enc, "base64").toString()));

    return {
        Provider: new k8s.Provider(name, { kubeconfig: kubeconfig }),
        Kubeconfig: kubeconfig,
    }
}

const k8sConfig = config.requireObject<types.KubernetesConfig>('Kubernetes')
const cluster = createCluster(pulumi.getStack(), k8sConfig);

const monitoringConfig = config.requireObject<types.MonitoringConfig>('Monitoring')
const monitoring = new k8s.helm.v3.Chart(
    'grafana-k8s-monitoring',
    {
        chart: "k8s-monitoring",
        namespace: "default",
        fetchOpts:{
            repo: "https://grafana.github.io/helm-charts",
        },
        values: {
            cluster: {
                name: pulumi.getStack(),
            },
            externalServices: monitoringConfig.ExternalServices,
            metrics: {
                extraMetricRelabelingRules: dedent(`
                    rule {
                        source_labels = ["pod"]
                        target_label = "instance"
                        action = "replace"
                    }
                `),
            },
            logs: {
                enabled: false,
                pod_logs: {
                    enabled: false,
                },
                cluster_events: {
                    enabled: false,
                },
            },
            opencost: {
                enabled: false,
            },
        },
    },
    { provider: cluster.Provider }
)

let installConfig = temporalConfig.SelfHosted
if (installConfig) {
    if (k8sConfig.AWS == undefined) {
        throw new Error("Self-hosted setup is only supported on AWS currently")
    }

    const awsConfig = k8sConfig.AWS

    const rdsSecurityGroup = new aws.ec2.SecurityGroup(pulumi.getStack() + "-rds", {
        vpcId: awsConfig.VpcId,
    });

    new aws.ec2.SecurityGroupRule(pulumi.getStack() + "-rds", {
        securityGroupId: rdsSecurityGroup.id,
        type: 'ingress',
        sourceSecurityGroupId: cluster.SecurityGroup,
        protocol: "tcp",
        fromPort: 3306,
        toPort: 3306,
    });

    const rdsInstance = new aws.rds.Instance(
        pulumi.getStack(),
        {
            allocatedStorage: 256,
            availabilityZone: awsConfig.AvailabilityZones[0],
            dbSubnetGroupName: awsConfig.RdsSubnetGroupName,
            vpcSecurityGroupIds: [rdsSecurityGroup.id],
            identifierPrefix: pulumi.getStack(),
            engine: "mysql",
            engineVersion: "8.0.36",
            instanceClass: "db.t4g.large",
            skipFinalSnapshot: true,
            username: "temporal",
            password: "temporal",
        },
    );

    installConfig = merge(
        {
            cassandra: {
                enabled: false
            },
            prometheus: {
                enabled: false
            },
            grafana: {
                enabled: false
             },
            elasticsearch: {
                enabled: false
            },
            postgresql: {
                enabled: false
            },
            mysql: {
                enabled: true
            },
            server: {
                config: {
                    persistence: {
                        default: {
                            driver: "sql",
                            sql: {
                                driver: "mysql8",
                                host: rdsInstance.address,
                                port: 3306,
                                user: "temporal",
                                password: "temporal",
                                database: "temporal_persistence",
                                maxConns: 20,
                                maxConnLifetime: "1h",
                            },
                        },
                        visibility: {
                            driver: "sql",
                            sql: {
                                driver: "mysql8",
                                host: rdsInstance.address,
                                port: 3306,
                                user: "temporal",
                                password: "temporal",
                                database: "temporal_visibility",
                                maxConns: 20,
                                maxConnLifetime: "1h",
                            },
                        },
                    },
                },
                dynamicConfig: {
                    "frontend.enableUpdateWorkflowExecution": [
                        { value: true }
                    ],
                },
                nodeSelector: { dedicated: "temporal" },
                tolerations: [
                    { key: "dedicated", operator: "Equal", value: "temporal", effect: "NoSchedule" }
                ],
            },
        },
        installConfig,
    )

    const temporalNamespace = new k8s.core.v1.Namespace(
        'temporal',
        { metadata: { name: 'temporal' } },
        { provider: cluster.Provider },
    )

    const temporal = new k8s.helm.v3.Chart(
        'temporal',
        {
            chart: "temporal",
            namespace: temporalNamespace.metadata.name,
            fetchOpts:{
                repo: "https://go.temporal.io/helm-charts",
            },
            values: installConfig,
            transformations: [
                (obj: any, opts: pulumi.CustomResourceOptions) => {
                    if (obj.kind === "Deployment" && obj.apiVersion === "apps/v1") {
                        if (obj.metadata && obj.metadata.name && obj.metadata.name === 'temporal-admintools') {
                            const container = { ...obj.spec.template.spec.containers[0] }
                            container.name = "create-namespace"
                            container.livenessProbe = undefined
                            container.command = ["bash", "-c", `temporal operator namespace describe ${temporalConfig.Namespace} || temporal operator namespace create ${temporalConfig.Namespace}`]
                            obj.spec.template.spec.initContainers = [
                                container
                            ]
                        }
                    }
                },
            ]
        },
        { provider: cluster.Provider, dependsOn: rdsInstance },
    )

    const omesConfig = { ...config.requireObject<omes.Config>('Omes'), ...{ Temporal: temporalConfig } };
    new omes.Deployment("omes", omesConfig, { provider: cluster.Provider, dependsOn: temporal.ready });
} else {
    const omesConfig = { ...config.requireObject<omes.Config>('Omes'), ...{ Temporal: temporalConfig } };
    new omes.Deployment("omes", omesConfig, { provider: cluster.Provider });
}

export const kubeconfig = cluster.Kubeconfig
