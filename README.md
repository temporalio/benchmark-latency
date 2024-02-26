# Temporal Latency Benchmarks

This repository provides a tool to measure latency for requests to a Temporal Server.

We use this tool to inform our users about the latencies they can expect when using Temporal Cloud or self-hosting. To help with infrastructure decisions we include latencies for hosting Temporal workers outside of a primary Temporal Cloud region, or with a different compute provider.

Note that these measurements are not performance tests, but rather show any latency costs associated with deploying Temporal Workers/Clients outside of the primary Temporal Cloud regions.

The requests which are measured are those which are most likely to affect the latency of an application starting or signalling workflows, or the throughput of an application's Temporal Workers.

The code is provide publically here so that users can see how we measured the latencies, and replicate the experiments if they wish.

We welcome any comments or suggestions on the metrics and approach used.

## Requirements

### Pulumi

This tool uses [Pulumi](https://www.pulumi.com/) to install workers into Kubernetes clusters, created using the managed Kubernetes services for the various Cloud providers.

To install on OS X you can use homebrew:

```shell
brew install pulumi/tap/pulumi
```

For other platforms, please see [Pulumi's install guide](https://www.pulumi.com/docs/install/).

Our Pulumi code uses Pulumi's Typescript SDK which relies on having Node.js installed. To install Node.js on OS X you can use homebrew:

```shell
brew install nodejs
```

For other platforms, please see [Node's installation docs](https://nodejs.org/en/download/package-manager/).

### Cloud Provider Credentials

In order to use the tools in this repository you will need to be able to authenticate to whichever cloud providers you would like to produce measurements for. Currently the tool supports AWS, GCP and Azure. To ease development of the tool, running against an existing Kubernetes cluster is also supported (for example Docker Deskop Kubernetes). You will only require credentials for those providers you would like to run the tests for.

Each provider will have different methods for authentication, please see Pulumi's docs for the platforms you are interested in testing:
* [AWS](https://www.pulumi.com/docs/clouds/aws/get-started/begin/#configure-pulumi-to-access-your-aws-account)
* [GCP](https://www.pulumi.com/docs/clouds/gcp/get-started/begin/#configure-pulumi-to-access-your-google-cloud-account)
* [Azure](https://www.pulumi.com/docs/clouds/azure/get-started/begin/#configure-pulumi-to-access-your-microsoft-azure-account)

The provider accounts you use will need to have the required permissions to create a cluster using the providers' managed Kubernetes service, and then tear it down once finished. Pulumi will show relevant errors if some permissions are missing.

