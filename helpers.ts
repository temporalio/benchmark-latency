import * as pulumi from "@pulumi/pulumi"
import * as types from './config'

export const scaleDeployment = (name: string, replicas: number) => {
    return (obj: any, opts: pulumi.CustomResourceOptions) => {
        if (obj.kind === "Deployment" && obj.metadata.name === name) {
            obj.spec.replicas = replicas
        }
    }
}

export const deploymentToStatefulset = (obj: any, opts: pulumi.CustomResourceOptions) => {
    if (obj.kind === "Deployment") {
        obj.kind = "StatefulSet"
    }
}

export const setLimits = (name: string, cpu: types.CPULimits, memory: types.MemoryLimits) => {
    return (obj: any, opts: pulumi.CustomResourceOptions) => {
        if (obj.kind === "Deployment" && obj.metadata.name === name) {
            const container = obj.spec.template.spec.containers[0];
            if (container.resources === undefined) {
                container.resources = { requests: {}, limits: {} }
            }
            if (cpu?.Request) {
                container.resources.requests.cpu = cpu.Request
            }
            if (memory?.Request) {
                container.resources.requests.memory = memory.Request
                container.resources.limits.memory = memory.Request
            }
        }
    }
}
