import axios from "axios"
import checksum from "checksum"
import fs from "fs"
import { execSync } from "child_process"
import { find, snakeCase, trim } from "lodash"

import nginxTemplate from "./nginx-template"
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
  const servers = [] // server section
  const upstreams = [] // all the upstreams
  //grab config from each service
  services.forEach((container) => {
    const certs = find(container.container_envvars, {key: "NGINX_CERTS"})
    const allCerts = !certs ? [] : certs.value.split(",").map(val => val.split("\\n").join("\n"))
    const port = find(container.container_envvars, {key: "NGINX_PORT"})
    const upstreamName = snakeCase(find(container.container_envvars, {key: "DOCKERCLOUD_SERVICE_HOSTNAME"}).value)

    //for each virtual host, write a cert file if SSL exists,
    //and return {host, ssl}
    const virtualHosts = find(container.container_envvars, {key: "NGINX_VIRTUAL_HOST"}).value
      .split(",")
      .map((host, i) => {
        let ssl = false

        //if certs exist, write them as files and set ssl to true
        if (allCerts[i] && allCerts[i].length) {
          fs.writeFileSync(`${certsPath}/${host}.crt`, allCerts[i])
          ssl = true
        }

        return { host: trim(host), upstreamName: upstreamName, ssl }
      })
      .forEach((virtualHost) => {
        const { host, ssl, upstreamName } = virtualHost
        //does a config for this host exist yet?
        let server = find(servers, { host })

        //create config for this host if it doesn't exist
        if (!server) {
          server = {
            host,
            ssl,
            upstreamName,
          }
          servers.push(server)
        }

        let upstream = find(upstreams, { upstreamName })
        if (!upstream) {
          upstream = {
            ipAndPort: [],
            upstreamName
          }
          upstreams.push(upstream)
        }

        //add this container's ip address to upstream for this host
        upstream.ipAndPort.push(`${container.private_ip}:${port ? port.value : 80}`)
      })
  })

  console.log(servers.length ? servers : "There are no services to load balance")

  return { servers:servers, upstreams:upstreams }
}

export function generateNewConfig(configs) {
  if (configs.servers.length) {
    const newNginxConf = nginxTemplate.render(configs)

    //reload nginx if config has changed
    checksum.file(configFileName, (err, sum) => {
      if (sum !== checksum(newNginxConf)) {
        reloadNginxConfig(newNginxConf)
      } else {
        console.log("Nginx config was unchanged");
      }
    });
  }
}

export function reloadNginxConfig(config) {
  fs.writeFileSync(configFileName, config);
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
