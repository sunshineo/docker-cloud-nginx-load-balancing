import hogan from "hogan.js"

export default hogan.compile(`#upstreams
{{#upstreams}}
  upstream {{upstreamName}} {
    {{#ipAndPort}}
      server {{.}};
    {{/ipAndPort}}
  }
{{/upstreams}}
#upstreams-end`)
