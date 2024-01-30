import * as pulumi from "@pulumi/pulumi";

import * as aws from "@pulumi/aws";
import * as gcp from "@pulumi/gcp";
import * as eks from "@pulumi/eks";
import * as azuread from "@pulumi/azuread";
import * as resources from "@pulumi/azure-native/resources";
import * as containerservice from "@pulumi/azure-native/containerservice";

import * as tls from "@pulumi/tls";
import * as k8s from "@pulumi/kubernetes";
import * as types from './config';

import * as omes from './omes';

import { dump } from 'js-yaml';
import dedent from 'dedent';

let config = new pulumi.Config();

function createCluster(name: string, config: types.ClusterConfig): Cluster {
    if (config.AWS != undefined) {
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
}

function eksCluster(name: string, config: types.ClusterConfig): Cluster {
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

    return {
        Provider: cluster.provider,
        Kubeconfig: cluster.kubeconfig.apply((kc) => dump(kc)),
    }
}

function gksCluster(name: string, config: types.ClusterConfig): Cluster {
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
            const context = `${gcp.config.project}_${gcp.config.zone}_${name}`;
            return dedent(`
                apiVersion: v1
                clusters:
                - cluster:
                    certificate-authority-data: ${masterAuth.clusterCaCertificate}
                    server: https://${endpoint}
                name: ${context}
                contexts:
                - context:
                    cluster: ${context}
                    user: ${context}
                name: ${context}
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

function aksCluster(name: string, config: types.ClusterConfig): Cluster {
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

const clusterConfig = config.requireObject<types.ClusterConfig>('Cluster')
const cluster = createCluster(pulumi.getStack(), clusterConfig);

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
                        source_labels = ["namespace"]
                        regex = "^$|omes"
                        action = "keep"
                    }

                    rule {
                        source_labels = ["__name__"]
                        regex = "temporal_.*_attempt_.*"
                        action = "drop"
                    }

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

const omesConfig = config.requireObject<omes.Config>('Omes');
new omes.Deployment("omes", omesConfig, { provider: cluster.Provider, dependsOn: [monitoring] });

export const kubeconfig = cluster.Kubeconfig;
