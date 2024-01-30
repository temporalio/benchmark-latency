import * as pulumi from "@pulumi/pulumi";

export interface AWSConfig {
    Region: string;
    VpcId: string;
    Role: string;
    PublicSubnetIds: string[];
    PrivateSubnetIds: string[];
    AvailabilityZones: string[];
}

export interface MonitoringConfig {
    ExternalServices: object;
}

export interface TemporalConfig {
    Host: string;
    TlsCert: string;
    TlsKey: string;
    Namespace: string;
    TaskQueue: string;
}

export interface ClusterConfig {
    AWS?: AWSConfig
    GCP?: boolean
    Azure: boolean
    NodeType: string
    NodeCount: number
}
