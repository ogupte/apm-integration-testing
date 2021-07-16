# APM Integration Testing - Fleet migration
These scripts simplify the setup required to make apm-integration-testing work to test the Fleet migration feature in APM.

## Prerequisites
- Node 14+
- Docker
- Docker Compose
- Python (version 3 preferred)

## Set up locally running Kibana for APM Fleet migration
1. Run `./scripts/fleet-migration/start.sh` to initialize the Fleet migration setup.
2. Checkout a branch in `kibana` (>=7.14) with these options set in `kibana.dev.yml`:
```
    xpack.apm.agent.migrations.enabled: true
    xpack.fleet.registryUrl: "https://epr-snapshot.elastic.co"
    elasticsearch.username: kibana_system_user
    elasticsearch.password: changeme
```
3. Start kibana with `node scripts/kibana.js --dev --port 5603 --no-base-path`
4. Log in to kibana and go to http://localhost:5603/app/fleet#/agents to confirm the Elastic Cloud agent policy is running on an Elastic Agent.
5. Go to http://localhost:5603/app/apm/settings/schema to test the migration.
6. Once the migration is complete, run `./scripts/fleet-migration/fleet-apm.sh` to update the services to point to the Fleet-managed APM Server.
7. Confirm that data streams are created at http://localhost:5603/app/fleet#/data-streams

## Usage
```
$ node ./scripts/fleet-migration/index.js [COMMAND]

Available commands: setup, start, fleet-apm, standalone-apm, down:

    setup:
        Creates the docker-compose.yml file and modifies it to work for Fleet
        migration testing.

    start:
        Creates the docker-compose.yml, modifies it, then starts all services
        in docker. Then, fleet server host and APM Server settings are push to
        kibana.

    fleet-apm:
        Updates all services to use the Fleet-managed APM Server instead of the
        standalone APM Server.

    standalone-apm:
        Updates all services to use the standalone APM Server instead of the
        Fleet-managed APM Server.

    down:
        Stops all services and removes all volumes.
```

## Customize
Customize the script `scripts/fleet-migration/generate_docker_compose.sh` to add familiar options you wish to the compose script: additional services, branches/snapshot, security, etc.
