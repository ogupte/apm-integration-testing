import { fileURLToPath } from 'url';
import { resolve, dirname, join, relative } from 'path';
import { promisify } from 'util';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as http from 'http';

const exec = promisify(child_process.exec);
const execFile = promisify(child_process.execFile);
const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PATH_ROOT = resolve(__dirname, '..', '..');
const PATH_GENERATE_DOCKER_COMPOSE_SH = join(__dirname, 'generate_docker_compose.sh');
const PATH_DOCKER_COMPOSE_YML = join(PATH_ROOT, 'docker-compose.yml');
const PATH_KIBANA_YML = join(__dirname, 'kibana.yml');

async function updateDockerComposeYml(getNextDCYmlObj) {
  const dockerComposeYmlString = (await readFile(PATH_DOCKER_COMPOSE_YML)).toString();
  const dockerComposeYmlObj = JSON.parse(dockerComposeYmlString);
  const nextDockerComposeYmlObj = await getNextDCYmlObj(dockerComposeYmlObj);
  await writeFile(PATH_DOCKER_COMPOSE_YML, JSON.stringify(nextDockerComposeYmlObj, null, 2));
}

async function createDockerComposeYml() {
  await execFile(PATH_GENERATE_DOCKER_COMPOSE_SH, { cwd: PATH_ROOT });
  await updateDockerComposeYml(dockerComposeYmlObj => {
    // update all "co.elastic.apm.stack-version=7.14.0" -> "co.elastic.apm.stack-version=7.14.0-SNAPSHOT"
    Object.keys(dockerComposeYmlObj.services).forEach(serviceName => {
      const service = dockerComposeYmlObj.services[serviceName];
      if (!service.labels) {
        return;
      }
      service.labels = service.labels.map(label => {
        if (label === 'co.elastic.apm.stack-version=7.14.0') {
          return 'co.elastic.apm.stack-version=7.14.0-SNAPSHOT';
        }
        return label;
      });
    });

    // add these environment variables to the elastic-agent service:
    Object.assign(dockerComposeYmlObj.services['elastic-agent'].environment, {
      ELASTICSEARCH_USERNAME: 'admin',
      ELASTICSEARCH_PASSWORD: 'changeme',
      FLEET_SERVER_POLICY_ID: 'policy-elastic-agent-on-cloud',
    });

    // mount customized kibana.yml to the kibana service:
    dockerComposeYmlObj.services['kibana'].volumes = [
      `./${relative(PATH_ROOT, PATH_KIBANA_YML)}:/usr/share/kibana/config/kibana.yml`,
    ];
    return dockerComposeYmlObj;
  });
}

async function request(options = {}, body) {
  return new Promise((resolve, reject) => {
    let responseData = Buffer.from('');
    const req = http.request(
      options.url,
      { ...options, headers: { 'Content-Type': 'application/json', 'kbn-xsrf': 'true', ...options.headers } },
      res => {
        res.on('end', () => {
          resolve(Object.assign(res, { body: JSON.parse(responseData.toString('utf8')) }));
        });
        res.on('data', chunk => {
          responseData = Buffer.concat([responseData, chunk]);
        });
      }
    );
    req.on('error', reject);
    if (body) {
      req.end(JSON.stringify(body));
    } else {
      req.end();
    }
  });
}

async function updateFleetServerHost() {
  return request(
    { method: 'PUT', url: 'http://admin:changeme@localhost:5601/api/fleet/settings' },
    { fleet_server_hosts: ['http://elastic-agent:8220'] }
  );
}

async function saveApmServerSchema() {
  return request(
    { method: 'POST', url: 'http://admin:changeme@localhost:5601/api/apm/fleet/apm_server_schema' },
    {
      'schema': {
        'apm-server.host': '0.0.0.0:8200',
        'apm-server.read_timeout': 3600,
        'apm-server.register.ingest.pipeline.enabled': true,
        'apm-server.rum.enabled': true,
        'apm-server.rum.rate_limit': 10,
        'apm-server.shutdown_timeout': '30s',
        'logging.level': 'error',
        'logging.metrics.enabled': false,
        'queue.mem.events': 2000,
        'queue.mem.flush.min_events': 267,
        'queue.mem.flush.timeout': '1s',
        'setup.template.settings.index.auto_expand_replicas': '0-1',
        'setup.template.settings.index.number_of_replicas': 1,
        'setup.template.settings.index.number_of_shards': 1,
      },
    }
  );
}

async function replaceDockerComposeYmlEnvVars(pattern, replacement) {
  await updateDockerComposeYml(dockerComposeYmlObj => {
    Object.keys(dockerComposeYmlObj.services).forEach(serviceName => {
      const service = dockerComposeYmlObj.services[serviceName];
      if (!service.environment) {
        return;
      }
      if (Array.isArray(service.environment)) {
        service.environment = service.environment.map(envVar => envVar.replace(pattern, replacement));
      } else {
        service.environment = Object.entries(service.environment).reduce((acc, [varName, value]) => {
          return { ...acc, [varName]: value.replace(pattern, replacement) };
        }, {});
      }
    });
    return dockerComposeYmlObj;
  });
}

async function waitForKibana() {
  return new Promise((resolve, reject) => {
    process.stdout.write('Waiting for kibana');
    const pollKibanaStatus = async () => {
      process.stdout.write('.');
      const response = await request({ url: 'http://localhost:5601/api/status', timeout: 1500 });
      if (response.statusCode === 200) {
        console.log(' ready!');
        resolve();
      } else {
        setTimeout(pollKibanaStatus, 1000);
      }
    };
    try {
      pollKibanaStatus();
    } catch (error) {
      reject(error);
    }
  });
}

async function execCommand(command) {
  console.log(`+ ${command}`);
  const execPromise = exec(command, { cwd: PATH_ROOT });
  execPromise.child.stdout.pipe(process.stdout);
  execPromise.child.stderr.pipe(process.stderr);
  return execPromise;
}

async function setupFleetMigrationEnv() {
  await createDockerComposeYml();
  console.log('Created docker-compose.yml for Fleet migration on Cloud.');
}

async function startFleetMigrationEnv() {
  await createDockerComposeYml();
  console.log('Created docker-compose.yml for Fleet migration on Cloud.');
  await execCommand('docker-compose up --detach');
  await waitForKibana();
  console.log('Updating Fleet with Elastic Agent host URL.');
  await updateFleetServerHost();
  console.log('Saving APM Server schema configuration to Kibana.');
  await saveApmServerSchema();
  console.log('Done.');
}

async function pointServicesToFleetApm() {
  console.log('Reconfiguring services to send events to the Fleet-managed APM Server.');
  await replaceDockerComposeYmlEnvVars('http://apm-server:8200', 'http://elastic-agent:8200');
  await execCommand('docker-compose up --detach');
  console.log('Done.');
}

async function pointServicesToStandalongApm() {
  console.log('Reconfiguring services to send events to the standalone APM Server.');
  await replaceDockerComposeYmlEnvVars('http://elastic-agent:8200', 'http://apm-server:8200');
  await execCommand('docker-compose up --detach');
  console.log('Done.');
}

async function dockerComposeDown() {
  await execCommand('docker-compose down -v');
  console.log('Done.');
}

const COMMANDS = [
  {
    name: 'setup',
    description: `Creates the docker-compose.yml file and modifies it to work for Fleet migration testing.`,
  },
  {
    name: 'start',
    description: `Creates the docker-compose.yml, modifies it, then starts all services in docker. Then, fleet server host and APM Server settings are push to kibana.`,
  },
  {
    name: 'fleet-apm',
    description: `Updates all services to use the Fleet-managed APM Server instead of the standalone APM Server.`,
  },
  {
    name: 'standalone-apm',
    description: `Updates all services to use the standalone APM Server instead of the Fleet-managed APM Server.`,
  },
  {
    name: 'down',
    description: `Stops all services and removes all volumes.`,
  },
];

switch (process.argv[2]) {
  case 'setup':
    await setupFleetMigrationEnv();
    break;
  case 'start':
    await startFleetMigrationEnv();
    break;
  case 'fleet-apm':
    await pointServicesToFleetApm();
    break;
  case 'standalone-apm':
    await pointServicesToStandalongApm();
    break;
  case 'down':
    await dockerComposeDown();
    break;
  default:
    console.log(`Available commands: ${COMMANDS.map(cmd => cmd.name).join(', ')}:\n`);
    console.log(COMMANDS.map(cmd => {
      return `    ${cmd.name}:\n        ${cmd.description}`;
    }).join('\n\n'));
    break;
}

