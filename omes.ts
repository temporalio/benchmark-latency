import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as types from './config';
import * as fs from 'fs';

export type Env = pulumi.Input<{ [key: string]: pulumi.Input<string> }>;

export interface WorkerConfig {
    Pods: number
    CPU: string
    Memory: string
    WorkflowPollers: number
    ActivityPollers: number
}

export interface ScenarioConfig {
    Pods: number
    CPU: string
    Memory: string
    ConcurrentWorkflows: number
}

export interface Config {
    Temporal: types.TemporalConfig
    Workers: WorkerConfig
    Scenario: ScenarioConfig
    Version: string
}

export const labelsFor = (component: string) => {
    return {
        "app.kubernetes.io/name": "omes",
        "app.kubernetes.io/component": component,
    }
}

const statefulset = (name: string, namespace: k8s.core.v1.Namespace, image: string, cmd: Array<string>, replicas: number, cpu: string, memory: string, tls: k8s.core.v1.Secret | undefined, opts?: pulumi.ComponentResourceOptions): k8s.apps.v1.StatefulSet => {
    const headlessService = new k8s.core.v1.Service(
        name,
        {
            metadata: {
                namespace: namespace.metadata.name,
                name: name,
                labels: labelsFor(name),
            },
            spec: {
                clusterIP: "None",
                selector: labelsFor(name),
                publishNotReadyAddresses: true,
                ports: [
                    {
                        name: "metrics",
                        port: 9090,
                        targetPort: "metrics",
                    },
                ],
            }
        },
        opts,
    )

    return new k8s.apps.v1.StatefulSet(
        name,
        {
            metadata: {
                namespace: namespace.metadata.name,
                name: name,
                labels: labelsFor(name),
            },
            spec: {
                serviceName: headlessService.metadata.name,
                replicas: replicas,
                selector: {
                    matchLabels: labelsFor(name),
                },
                template: {
                    metadata: {
                        labels: labelsFor(name),
                    },
                    spec: {
                        containers: [
                            {
                                image: image,
                                imagePullPolicy: 'Always',
                                name: name,
                                command: cmd,
                                ports: [
                                    { name: "metrics", containerPort: 8000 },
                                ],
                                volumeMounts: tls ? [ { name: "tls", mountPath: "/etc/temporal/tls" } ] : [],
                                resources: {
                                    requests: {
                                        cpu: cpu,
                                        memory: memory,
                                    },
                                }
                            }
                        ],
                        volumes: tls ? [ { name: "tls", secret: { secretName: tls.metadata.name } } ] : [],
                        restartPolicy: "OnFailure",
                    },
                },
            },
        },
        opts,
    );
}

export class Deployment extends pulumi.ComponentResource {
    constructor(name: string, args: Config, opts?: pulumi.ComponentResourceOptions) {
        super("omes:Deployment", name, args, opts);

        const namespace = new k8s.core.v1.Namespace(
            name,
            { metadata: { name: name } },
            { ...opts, parent: this },
        )

        let tls: k8s.core.v1.Secret | undefined

        if (args.Temporal.TlsKey) {
            tls = new k8s.core.v1.Secret(
                "tls",
                {
                    metadata: { namespace: namespace.metadata.name },
                    type: "kubernetes.io/tls",
                    stringData: {
                        "tls.key": fs.readFileSync(args.Temporal.TlsKey, 'utf8'),
                        "tls.crt": fs.readFileSync(args.Temporal.TlsCert, 'utf8'),
                    },
                },
                { ...opts, parent: this },
            )    
        }

        const image = `temporaliotest/omes:${args.Version}`
        
        let tlsOptions: string[] = []
        if (tls != undefined) {
            tlsOptions = [
                "--tls",
                "--tls-cert-path",
                "/etc/temporal/tls/tls.crt",
                "--tls-key-path",
                "/etc/temporal/tls/tls.key",
            ]
        }

        const worker = statefulset(
            "worker",
            namespace,
            image,
            [
                "/app/temporal-omes",
                "run-worker",
                "--language",
                "go",
                "--dir-name",
                "prepared",
                "--namespace",
                args.Temporal.Namespace,
                "--scenario",
                "throughput_stress",
                "--run-id",
                args.Temporal.TaskQueue,
                ...tlsOptions,
                "--worker-prom-listen-address",
                "0.0.0.0:8000",
                "--worker-max-concurrent-activity-pollers",
                args.Workers.ActivityPollers.toString(),
                "--worker-max-concurrent-workflow-pollers",
                args.Workers.WorkflowPollers.toString(),
                "--server-address",
                args.Temporal.Host,
            ],
            args.Workers.Pods,
            args.Workers.CPU,
            args.Workers.Memory,
            tls,
            { ...opts, parent: this }
        )

        // TODO: This should probably be a job as it only needs to run for a short duration.
        const runner = statefulset(
            "run-scenario",
            namespace,
            image,
            [
                "/app/temporal-omes",
                "run-scenario",
                "--namespace",
                args.Temporal.Namespace,
                "--scenario",
                "throughput_stress",
                "--duration",
                "2h",
                "--max-concurrent",
                args.Scenario.ConcurrentWorkflows.toString(),
                "--run-id",
                args.Temporal.TaskQueue,
                ...tlsOptions,
                "--prom-listen-address",
                "0.0.0.0:8000",
                "--server-address",
                args.Temporal.Host,
            ],
            args.Scenario.Pods,
            args.Scenario.CPU,
            args.Scenario.Memory,
            tls,
            { ...opts, parent: this }
        )

        const serviceMonitor = new k8s.apiextensions.CustomResource(
            "omes-monitor",
            {
                apiVersion: "monitoring.coreos.com/v1",
                kind: "ServiceMonitor",
                metadata: {
                    namespace: namespace.metadata.name,
                    name: "omes-monitor",
                },
                spec: {
                    selector: {
                        matchLabels: {
                            "app.kubernetes.io/name": "omes"
                        }
                    },
                    endpoints: [
                        { port: "metrics" }
                    ]
                }
            },
            { ...opts, parent: this }
        )
    }
}
