import axios from "axios"
import checksum from "checksum"
import fs from "fs"
import { execSync } from "child_process"
import { find, snakeCase, trim } from "lodash"

//import nginxTemplate from "./nginx-template"
import upstreamsTemplate from "./upstreams-template"
import { api as dockerCloud } from "./docker-cloud"

const { NGINX_LB_NAME: lbName, SLACK_WEBHOOK: slackWebhook } = process.env
const configFileName = process.env.NGINX_CONFIG_FILE || "/etc/nginx/conf.d/default.conf"
const certsPath = process.env.NGINX_CERTS || "/certs"
const containerLimit = process.env.CONTAINER_LIMIT || "25"

try {
  fs.mkdirSync(certsPath)
} catch(e) {}

/*
 Sequence of Events
*/
export default function() {
  // list all containers
  dockerCloud(`/api/app/v1/container/?limit=${containerLimit}`)
    .then(fetchFullContainerDetail)
    .then(getContainersToBalance)
    .then(parseServices)
    .then(generateNewConfig)
    .catch(err => console.log("Error:", err, err.stack))
}


/*
Helper Functions
*/

export function fetchFullContainerDetail(allContainers) {
  // Fetch-in-parallel the full resource for each container
  return Promise.all(
    allContainers.objects.map(container => dockerCloud(container.resource_uri))
  )
}

export function getContainersToBalance(allContainers) {
  //find containers that have an NGINX_LB env var that matches my NGINX_LB_NAME value
  return allContainers
    .filter((container) => {
      return container.container_envvars
        .filter(env => env.key === "NGINX_LB" && env.value === lbName)
        .length
    })
    //I only care about running containers
    .filter((container) => container.state === "Running")
}

export function parseServices(services) {
  const upstreams = [] // all the upstreams
  //grab config from each service
  services.forEach((container) => {
    const envvars = container.container_envvars;

    // Add a new upstream if not added already
    const upstreamName = snakeCase(find(envvars, {key: "DOCKERCLOUD_SERVICE_HOSTNAME"}).value)
    let upstream = find(upstreams, { upstreamName: upstreamName })
    if (!upstream) {
      // This is the first time we see a container for this service
      upstream = {
        ipAndPort: [],
        upstreamName: upstreamName
      }
      upstreams.push(upstream)
    }
    //add this container's ip address to the upstream as one server
    // This may be adding first server, or nth server to an existing upstream
    const port = find(envvars, {key: "NGINX_PORT"})
    upstream.ipAndPort.push(`${container.private_ip}:${port ? port.value : 80}`)
  })

  console.log("upstreams built:")
  console.log(upstreams.length ? upstreams : "There are no upstreams to load balance")

  return { upstreams:upstreams }
}

export function generateNewConfig(configs) {
  //const newNginxConf = nginxTemplate.render(configs)
  const newNginxConf = upstreamsTemplate.render(configs)
  //reload nginx if config has changed

  checksum.file(configFileName, (err, sum) => {
    if (sum !== checksum(newNginxConf)) {
      reloadNginxConfig(newNginxConf)
    } else {
      console.log("Nginx config was unchanged");
    }
  });
}

export function reloadNginxConfig(config) {
  //fs.writeFileSync(configFileName, config);
  var fileStr = fs.readFileSync(configFileName).toString();
  var replacedStr = fileStr.replace(/#upstreams[\s\S]+#upstreams-end/m, config);
  fs.writeFileSync(configFileName, replacedStr);

  const testCmd = process.env.NGINX_RELOAD === "false" ? "" : "nginx -t";
  const reloadCmd = process.env.NGINX_RELOAD === "false" ? "" : "service nginx reload";
  console.log("Testing new Nginx config...");

  try {
    execSync(testCmd);
    execSync(reloadCmd);
    console.log('Nginx reload successful');
    console.log(config);
  } catch(e) {
    configFailed(config, e);
  }
}

export function configFailed(config, stderr) {
  console.log("Config failed", stderr);
  console.log(config);

  if (slackWebhook) {
    const text = `Nginx (${lbName}) config failed:
*Error:*
\`\`\`${stderr}\`\`\`
*Config:*
\`\`\`${config}\`\`\`
    `

    axios.post(slackWebhook, {text, username: `Nginx ${lbName}`});
  }
}
