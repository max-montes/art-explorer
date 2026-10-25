# Deployment

Art Explorer is a stateful application. Production search requires:

- A long-running Node.js process for local ONNX inference.
- PostgreSQL 17 with pgvector.
- The populated catalog database, currently about 591 MB.
- Persistent storage for downloaded Jina and SigLIP model files.

Serverless-only platforms are not a good fit because model initialization is
too expensive for short-lived functions.

## Build and run the container

```bash
docker build -t art-explorer .
docker run --rm -p 3000:3000 \
  -e DATABASE_URL=postgresql://user:password@host:5432/art_explorer \
  -e CATALOG_REPOSITORY=postgres \
  -e EMBEDDING_PROVIDER=transformers \
  -e QUERY_MODEL_ROUTING=auto \
  -e ONNX_INTRA_OP_THREADS=1 \
  -e ONNX_INTER_OP_THREADS=1 \
  -v art-explorer-models:/data/models \
  art-explorer
```

The health endpoint is `GET /api/health`. It verifies database access and
reports catalog and Jina image-vector counts without loading the model.

## Move the catalog

Create a compressed dump from the local database:

```bash
docker exec tmp-postgres-1 pg_dump \
  -U art_explorer \
  -d art_explorer \
  --format=custom \
  --no-owner \
  --no-acl \
  > art-explorer.dump
```

Restore it into a new, empty PostgreSQL database whose server has pgvector
installed:

```bash
pg_restore \
  --exit-on-error \
  --no-owner \
  --no-acl \
  --dbname="$DATABASE_PUBLIC_URL" \
  art-explorer.dump
```

Do not commit the dump. It contains the complete vector catalog and is hundreds
of megabytes.

After restore, verify coverage:

```sql
SELECT count(*) AS assets,
       count(embedding.jina_image_embedding) AS jina_images,
       count(embedding.image_embedding) AS siglip_images
  FROM media_assets asset
  LEFT JOIN media_embeddings embedding
    ON embedding.asset_id = asset.id;
```

## Azure

`infra/azure/` adapts the existing
[Art Guide Bicep templates](https://github.com/max-montes/art-guide/tree/main/infra/azure),
not EV2 rollout specifications. It provisions separate Art Explorer resources:

- Azure Container Apps: 2 vCPUs, 4 GiB, maximum one replica.
- PostgreSQL Flexible Server: PostgreSQL 17, B1ms, 32 GiB storage, pgvector
  allow-listed, seven-day backups.
- ACR Basic and a user-assigned identity with `AcrPull`.
- Azure Files mounted at `/data/models` for persistent model caching.
- Log Analytics with a 0.1 GB daily ingestion cap.

No Azure OpenAI resource or API key is needed. Search stays on the evaluated
local Jina/SigLIP models. No Art Guide production resources are reused or
modified.

### Current deployment

The public app is
[Art Explorer](https://art-explorer.thankfulforest-eee49b89.westus3.azurecontainerapps.io/),
deployed on 2026-10-09 in `art-explorer-prod-rg`, using the Visual Studio
Enterprise subscription. The web app has one minimum and maximum
replica; PostgreSQL remains running on B1ms.

The web app is named `art-explorer`; the other resources retain the
`art-explorer-prod` prefix. Passage Explorer is available at `/passages`, and
`/assistant` redirects there.

The live catalog contains 17,384 artworks and 17,380 vectors for each image
model. General image search and SigLIP style routing work, and remote curator
requests return 403. The top five `ships` results match the local deployment.

With the uploaded model cache, the first Azure Jina search took 23.46 seconds;
subsequent `flags` and `battle` searches took 0.46 and 0.34 seconds. First SigLIP
initialization and search took 7.10 seconds. These are individual API request
times, not complete scale-from-zero measurements. The initial wake-up health
request exceeded 30 seconds; Azure reported a 13.86-second image pull. Keep the
20-60-second cold-visit range provisional until measuring a full cold visit.

### Preview and deploy

Requires Azure CLI with Bicep, Node.js, and an authenticated subscription.
Set the password through a secure shell prompt; do not put it in git, command
history, or the parameters file. Reuse the same password on subsequent
deployments unless intentionally rotating it.

```bash
export AZURE_SUBSCRIPTION_ID="<your-credit-subscription-id>"
read -rs -p "PostgreSQL admin password: " PG_ADMIN_PASSWORD
echo
export PG_ADMIN_PASSWORD
bash infra/azure/deploy.sh preview
```

Preview compiles without creating a resource group if none exists. If the
group exists, preview runs Azure what-if without applying changes.

After approving the resources and costs, provision the foundation:

```bash
bash infra/azure/deploy.sh apply
```

The default group is `art-explorer-prod-rg` in `westus3`. Names for the registry,
database server, and storage account include a unique resource-group suffix.
The deployment outputs include `registryName`, `registryServer`, and
`postgresHost`.

Build the image for Azure's Linux architecture in ACR:

```bash
az acr build --subscription "$AZURE_SUBSCRIPTION_ID" \
  --registry "<registryName>" \
  --image art-explorer:v1 --platform linux/amd64 .
export AZURE_APP_IMAGE="<registryServer>/art-explorer:v1"
```

Allow your current public IPv4 address only for the database restore:

```bash
export RESTORE_CLIENT_IP="<your-public-ipv4-address>"
unset AZURE_APP_IMAGE
bash infra/azure/deploy.sh apply
```

Connect with TLS certificate verification and restore the catalog as described
above. The PostgreSQL username is `artexploreradmin`; the database is
`art_explorer`. Use the deployment's `postgresHost` and `sslmode=verify-full`.
Restore before deploying the web app: its readiness check requires image
embeddings in the database.

After the catalog is restored, deploy the real app image:

```bash
export AZURE_APP_IMAGE="<registryServer>/art-explorer:v1"
bash infra/azure/deploy.sh preview
bash infra/azure/deploy.sh apply
```

Remove the temporary restore firewall rule afterward:

```bash
az postgres flexible-server firewall-rule delete \
  --subscription "$AZURE_SUBSCRIPTION_ID" \
  --resource-group art-explorer-prod-rg \
  --name "<postgresName>" --rule-name RestoreClient --yes
unset RESTORE_CLIENT_IP PG_ADMIN_PASSWORD
```

The template's `AllowAzureServices` firewall rule permits Azure-origin IPs
across subscriptions, not just your application. TLS and database credentials
are still required. For a stricter deployment, replace this with private
networking. Do not open `0.0.0.0` through `255.255.255.255`.

PostgreSQL child-resource changes are serialized in the template because
Flexible Server rejects overlapping management operations with `ServerIsBusy`.

### Costs and launch checks

West US 3 public USD pay-as-you-go rates checked against the
[Azure Retail Prices API](https://prices.azure.com/api/retail/prices) on
2026-10-08, using 730 running hours per month:

| Database option | Compute | 32 GiB storage | Monthly total |
| --- | ---: | ---: | ---: |
| B1ms (1 vCore, 2 GiB) | $12.41 | $3.68 | $16.09 |
| B2s (2 vCores, 4 GiB) | $49.64 | $3.68 | $53.32 |
| General Purpose Ddsv5 (2 vCores, 8 GiB) | $129.94 | $3.68 | $133.62 |

Start with B1ms for a low-traffic beta. Burstable is not the recommendation for
sustained production load: monitor CPU Credits Remaining, memory, connections,
and search latency. Upgrade if credits regularly drain or memory causes I/O
pressure. No high availability, read replicas, or paid extra IOPS are enabled.
Backup storage up to the provisioned storage size is included; excess backups
and network egress can cost extra. Azure bills provisioned storage even though
the current catalog occupies only about 591 MB.

For one Container Apps Consumption replica at 2 vCPUs and 4 GiB, current meters
imply approximately $47/month at idle rates and $158/month at fully active rates
before monthly free grants. If the subscription's free grants are available,
those become approximately $46 and $152. Idle billing requires meeting Azure's
idle-usage criteria; background activity or extra CPU can keep the app actively
billed. ACR Basic, Azure Files, logs, and egress add costs on top.

A working allowance is $65-$85/month for the whole low-traffic deployment,
around $175/month if this sizing remains actively billed continuously.
Higher memory/CPU allocation or multiple replicas changes that estimate.
Confirm the actual subscription rates and region before provisioning; these
are estimates, not a guaranteed bill.

The $150/month Azure credit is a budget, not a guarantee of zero billing.
Region, runtime memory, traffic, model storage, registry, database storage and
logs all affect usage. Set subscription budget notifications in Azure Cost
Management before applying; alerts do not stop resources or cap spending.
Other projects on the subscription also consume the credit.

Production sets `minReplicas` to one so the app and its loaded search models
stay warm between visits. At 2 vCPUs and 4 GiB, one continuously idle replica
is estimated at about $47/month before applicable subscription free grants;
active compute can cost more. Add about $21/month for PostgreSQL and ACR, plus
Azure Files, logging and other usage. These are estimates, not a guaranteed
bill; actual subscription usage includes other projects.

For comparison, setting `minReplicas` to zero removes application compute
charges while the app is scaled down, but the first visit must wait for the
container to start. Active compute at 2 vCPUs and 4 GiB is about $0.216/hour
before free grants.

With scale-to-zero disabled in production, the container stays running, but the
first use of a model in a fresh container can still initialize ONNX. A
fresh-process test on the development Mac with cached Jina
files took 2.94 seconds for initialization plus the first query, versus 0.13
seconds for the next query. This is not an Azure benchmark: CPU, Azure Files
throughput, image pull, scheduling and network overhead change the result.
Allow approximately 20-60 seconds for a cached cold visit as a provisional
planning range, potentially longer; first-ever model downloads can take
minutes. Measure the real deployment before promising a latency target.

The UI shows "Waking up Art Explorer..." after five seconds of waiting.
Search and similarity requests retry 502/503/504 twice, stop waiting after two
minutes, and show a retry action on failure. New navigation cancels the old
request. This message can still appear during slow searches or model
initialization. `/api/health` verifies the database, not loaded-model readiness.

The same container serves the frontend, so a first visitor cannot see the
message until the initial HTML and JavaScript load. An instant wake-up screen
while the web container itself starts requires a separately hosted static
frontend. Existing open tabs can display the message immediately when a later
search wakes the backend.

Before publishing the URL, verify `/api/health`, then `ships`, `flags`,
`battle`, and a style query such as `impressionism`. Confirm remote curation
returns 403 and that a container restart retains `/data/models`. The configured
4 GiB is a starting point: a local Linux container smoke test reached about
3.15 GiB after its first Jina query and 3.53 GiB with SigLIP also loaded.
Both searches completed with a 4 GiB container memory limit. Measure peak
memory on Azure's architecture and under concurrent searches before increasing
traffic.

## Self-host without a platform fee

The existing Mac can run the application and PostgreSQL continuously, with a
secure tunnel or reverse proxy providing the public URL. This avoids a hosting
platform bill but requires:

- Keeping the Mac awake, online, and patched.
- Restricting remote curation with `ALLOW_REMOTE_CURATION=false`.
- Configuring TLS and access through a trusted tunnel provider.
- Accepting home-network and machine-availability limits.

Do not expose PostgreSQL publicly. Only the web application should be reachable
through the tunnel.
