// Adapted from max-montes/art-guide's Azure Bicep deployment.
targetScope = 'resourceGroup'

param location string = resourceGroup().location

@minLength(3)
@maxLength(20)
param prefix string = 'art-explorer-prod'

param pgAdminUser string = 'artexploreradmin'

@secure()
param pgAdminPassword string

// Provision the registry and pull identity first, then deploy a real image.
param deployApp bool = false
param appImage string = ''

@allowed([0, 1])
param minReplicas int = 0

param restoreClientIp string = ''

var suffix = uniqueString(resourceGroup().id)
var tags = {
  project: 'art-explorer'
  env: 'prod'
  managedBy: 'bicep'
}
var databaseUrl = 'postgresql://${pgAdminUser}:${uriComponent(pgAdminPassword)}@${postgres.properties.fullyQualifiedDomainName}:5432/art_explorer?sslmode=verify-full'

resource logs 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: '${prefix}-logs'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    workspaceCapping: { dailyQuotaGb: json('0.1') }
  }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${prefix}-env'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: 'artexplorer${suffix}'
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false }
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-app'
  location: location
  tags: tags
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, identity.id, 'AcrPull')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'artmodels${suffix}'
  location: location
  tags: tags
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource modelShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileService
  name: 'models'
  properties: { shareQuota: 10 }
}

resource modelMount 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: environment
  name: 'models'
  properties: {
    azureFile: {
      accountName: storage.name
      accountKey: storage.listKeys().keys[0].value
      shareName: modelShare.name
      accessMode: 'ReadWrite'
    }
  }
}

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: '${prefix}-pg-${suffix}'
  location: location
  tags: tags
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    administratorLogin: pgAdminUser
    administratorLoginPassword: pgAdminPassword
    version: '17'
    storage: { storageSizeGB: 32 }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: { mode: 'Disabled' }
    network: { publicNetworkAccess: 'Enabled' }
    authConfig: {
      passwordAuth: 'Enabled'
      activeDirectoryAuth: 'Disabled'
    }
  }
}

// This allows all Azure-origin addresses, not just this subscription.
// PostgreSQL still requires TLS and credentials. Use private networking
// instead if deploying beyond this small personal project.
resource azureFirewall 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: postgres
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

resource restoreFirewall 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = if (!empty(restoreClientIp)) {
  parent: postgres
  name: 'RestoreClient'
  properties: {
    startIpAddress: restoreClientIp
    endIpAddress: restoreClientIp
  }
}

resource extensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: postgres
  name: 'azure.extensions'
  properties: {
    value: 'vector'
    source: 'user-override'
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: 'art_explorer'
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

resource app 'Microsoft.App/containerApps@2024-03-01' = if (deployApp) {
  name: '${prefix}-web'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
      registries: [{
        server: registry.properties.loginServer
        identity: identity.id
      }]
      secrets: [{
        name: 'database-url'
        value: databaseUrl
      }]
    }
    template: {
      containers: [{
        name: 'web'
        image: appImage
        resources: {
          cpu: 2
          memory: '4Gi'
        }
        env: [
          { name: 'DATABASE_URL', secretRef: 'database-url' }
          { name: 'CATALOG_REPOSITORY', value: 'postgres' }
          { name: 'EMBEDDING_PROVIDER', value: 'transformers' }
          { name: 'IMAGE_EMBEDDING_MODEL', value: 'jinaai/jina-clip-v2' }
          { name: 'QUERY_MODEL_ROUTING', value: 'auto' }
          { name: 'JINA_QUERY_TASK', value: 'on' }
          { name: 'TRANSFORMERS_CACHE_DIR', value: '/data/models' }
          { name: 'ALLOW_REMOTE_CURATION', value: 'false' }
          { name: 'PORT', value: '3000' }
          { name: 'ONNX_INTRA_OP_THREADS', value: '1' }
          { name: 'ONNX_INTER_OP_THREADS', value: '1' }
        ]
        volumeMounts: [{
          volumeName: 'models'
          mountPath: '/data/models'
        }]
        probes: [
          {
            type: 'Liveness'
            tcpSocket: { port: 3000 }
            initialDelaySeconds: 20
            periodSeconds: 30
          }
          {
            type: 'Readiness'
            httpGet: { path: '/api/health', port: 3000 }
            timeoutSeconds: 10
            periodSeconds: 30
          }
        ]
      }]
      volumes: [{
        name: 'models'
        storageType: 'AzureFile'
        storageName: modelMount.name
        mountOptions: 'uid=1000,gid=1000,dir_mode=0770,file_mode=0660'
      }]
      scale: {
        minReplicas: minReplicas
        maxReplicas: 1
        rules: [{
          name: 'http'
          http: { metadata: { concurrentRequests: '5' } }
        }]
      }
    }
  }
  dependsOn: [
    acrPull
    extensions
    database
    azureFirewall
  ]
}

output registryName string = registry.name
output registryServer string = registry.properties.loginServer
output postgresName string = postgres.name
output postgresHost string = postgres.properties.fullyQualifiedDomainName
output appUrl string = deployApp ? 'https://${app!.properties.configuration.ingress.fqdn}' : ''
