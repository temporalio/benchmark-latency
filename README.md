# Temporal Latency Benchmarks

This repository provides an automated way to run latency benchmarks against a Temporal Cluster. These can be run against [Temporal Cloud](https://temporal.io/cloud) or a self-hosted cluster.

Note the benchmark setup is not configured for load testing. The workload used is deliberately very light, in order to measure the latencies inherent in the system. A heavy load scenario could easily be measured with small adjustments to the code.

## Pre-requisites

### Pulumi

We use [Pulumi](https://www.pulumi.com/) to create a Kubernetes cluster to host the Temporal Workers and load test tool used for the benchmark (and optionally install a Temporal Cluster for you).

If you don't already use Pulumi, please follow the guides linked to below to install and configure it for the Cloud Provider you would like to use. Note: You will not need Pulumi Cloud to run these benchmarks.

Our tool supports AWS, GCP and Azure. Please note when following the Pulumi install docs that our tool uses the nodejs language runtime for Pulumi.
* [AWS](https://www.pulumi.com/docs/clouds/aws/get-started/begin/)
* [GCP](https://www.pulumi.com/docs/clouds/gcp/get-started/begin/)
* [Azure](https://www.pulumi.com/docs/clouds/azure/get-started/begin/)

If you would like our tool to install a self-hosted Temporal Cluster to run the benchmarks against, please note this is currently only supported in AWS.

Once Pulumi is installed, configure Pulumi to save state locally rather than to Pulumi Cloud.

```shell
pulumi login --local
```

Our tool uses a few Pulumi plugins to talk to AWS, GCP and Azure. Please install these plugins by running `npm install` after Pulumi is installed.

### Temporal Cluster credentials

If you are testing Temporal Cloud (or an existing self-hosted Temporal Cluster which relies on mTLS), you will need the TLS certificates for the cluster you would like to benchmark.

### Prometheus service

The clusters used for the benchmarking are expected to be transient. For this reason, our tool does not install Prometheus into the benchmark cluster, but rather expects configuration for an external Prometheus instance. Metrics will be pushed to the external Prometheus instance using remote write. We have used Grafana Cloud's managed Prometheus service for this, but you can use any hosted Prometheus service (including one on your own infrastructure, as long as the benchmark cluster can connect to it).

## Configuration

You will need to create a [Pulumi Stack](https://www.pulumi.com/docs/concepts/stack/) to run the benchmarks. The stack is configured with details of the Cloud Provider, size/count of nodes to use for the Kubernetes cluster, and details of the Temporal Cluster to benchmark against.

Example stack configurations are provided in the `examples/` directory:
* `Pulumi.aws-existing-cluster.yaml`: Workers in AWS connecting to an existing cluster or Temporal Cloud
* `Pulumi.aws-ephemeral-temporal.yaml`: Workers in AWS connecting to an ephemeral self-hosted Temporal Cluster built by our tool
* `Pulumi.gcp-existing-cluster.yaml`: Workers in GCP connecting to an existing cluster or Temporal Cloud
* `Pulumi.azure-existing-cluster.yaml`: Workers in Azure connecting to an existing cluster or Temporal Cloud

To use one of these examples, copy the file from the `examples/` directory to the root directory of this repo. Edit the file as required (they include comments to help you adjust them).

## Running a benchmark

Once you have configured a stack to your requirements, you can build all the required resources using Pulumi. To avoid lots of typing, we suggest you set a shell variable "stack" to the name of the stack you will be building. For example, if you're using the `examples/Pulumi.aws-temporal-cloud.yaml` stack configuration, the stack name is `aws-temporal-cloud`, so you can set the stack variable like so:

```shell
export stack=aws-existing-cluster
```

You may need to adjust the syntax for your shell if you are not using `bash`.

You can then bring the stack up and run the benchmark using:

```shell
pulumi stack -s $stack up
```

That will show you a preview of resources that will be created. Hitting `return` will confirm, and Pulumi will then create the requires resources.

When everything is built, the benchmark will start automatically and begin sending all SDK metrics to your Prometheus instance.

By default the benchmark is set to run for an hour to give a reasonable amount of data, but you do not need to wait that long if you'd prefer to end it sooner. When you are ready to bring the stack down, you can use:

```shell
pulumi stack -s $stack down
```

This will show you a preview, and once confirmed, destroy all the resources that were created for the benchmarking in your Cloud Provider.

Generally, 15 minutes should be enough time to get a feel for the latency performance of a system, as this benchmark is not a load test which may change as load builds up. The default run time has been set to an hour so that if you are bringing up multiple clusters at the same time you have a better chance of at least 15 minute overlap between them (different configurations and Cloud Providers will vary in how quickly they come up). This makes comparison in Grafana or similar easier as the metrics will be in the same time ranges.

## Useful Metrics

The following SDK metrics are those that we believe are particularly useful when evaulating/comparing systems running this benchmark:

* [StartWorkflowExecution](https://docs.temporal.io/references/sdk-metrics#request_latency): Application code uses a StartWorkflowRequest in order to start a Workflow Execution on Temporal. This latency metric measures the amount of time an application will have to wait before the request to start a workflow is acknowledged.
* [SignalWorkflowExecution](https://docs.temporal.io/references/sdk-metrics#request_latency) Application code uses a SignalWorkflowExecution to inform a running Workflow Execution of an external event. This latency metric measures the amount of time an application will have to wait before the signal request is acknowledged.
* [Workflow End to End Latency](https://docs.temporal.io/references/sdk-metrics#workflow_endtoend_latency): While not comparable across different workloads, in the case where Temporal Clusters are running the same code this can give an indication of the effect of the system's latency. Improvements in all the latency metrics mentioned below will result in improvements in this end to end latency.
* [RespondWorkflowTaskCompleted](https://docs.temporal.io/references/sdk-metrics#request_latency): Workers reply to Temporal Server with the result of each Worfklow Task as a Workflow Execution makes progress. This latency measures the amount of time it takes for the Worker to receive an acknowledgement from Temporal Server.
* [RespondActivityTaskCompleted](https://docs.temporal.io/references/sdk-metrics#request_latency): Workers reply to Temporal Server with the result of each Activity Task. This latency measures the amount of time it takes for the Worker to receive an acknowledgement from Temporal Server.

In order to know that the system isn't being overloaded (which would affect baseline latency), you can check the following metrics:

* [WorkflowTaskScheduleToStartLatency](https://docs.temporal.io/references/sdk-metrics#workflow_task_schedule_to_start_latency): This metric measures the latency between a Workflow Task being created and being executed on a Worker. A properly tuned system with low load should have a figure under 150ms here, ideally closer to 50ms. If your latency is too high here, consider adding more Workflow Task Pollers on your Workers, or adding more Workers, via the stack configuration.
* [WorkflowTaskScheduleToStartLatency](https://docs.temporal.io/references/sdk-metrics#activity_task_schedule_to_start_latency): This metric measures the latency between an Activity Task being created and being executed on a Worker. A properly tuned system with low load should have a figure under 150ms here, ideally closer to 50ms. If your latency is too high here, consider adding more Actitivity Task Pollers on your Workers, or adding more Workers, via the stack configuration.

If you are benchmarking a self-hosted Temporal Cluster, server side metrics will be useful for investigating where there are bottlenecks and what might be improved to get lower latencies. Discussing those is out of scope for this project, but you can find some useful information on our blog: https://temporal.io/blog/scaling-temporal-the-basics.