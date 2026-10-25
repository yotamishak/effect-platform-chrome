export function element<A extends HTMLElement>(selector: string): A {
  const found = document.querySelector<A>(selector)

  if (found === null) throw new Error(`Missing playground element: ${selector}`)

  return found
}

export function renderPlayground() {
  const isPanel = location.pathname === "/sidepanel.html"

  document.body.classList.toggle("sidepanel", isPanel)
  element("#app").innerHTML = `
    <header class="page-header">
      <div><p class="eyebrow">Effect × Chrome</p><h1>Extension playground</h1>
        <p>Explore one module at a time. Every card has its own stress test and results.</p></div>
      <div class="header-actions">
        <button id="open-playground">Open in a tab</button>
        <button id="panel-open" disabled>Open side panel</button>
      </div>
    </header>
    <div class="toolbar">
      <label>Demo value <input id="value" value="Hello Effect"></label>
      <label>Find a module <input id="module-search" type="search" placeholder="Storage, tabs, RPC…" aria-controls="module-grid"></label>
      <p id="module-count" role="status"></p>
    </div>
    <main id="module-grid" class="module-grid">
      <section class="module-card" data-module="ChromeStorage"><h2>ChromeStorage</h2>
        <p>Read and write the demo key. Storage changes appear in the event log.</p>
        <div class="card-actions"><button id="storage-write">Write local / sync / session</button><button id="storage-read">Read demo keys</button><button id="managed">Read managed policy</button></div>
      </section>
      <section class="module-card" data-module="ChromeKeyValueStore"><h2>ChromeKeyValueStore</h2>
        <p>Namespaced strings and binary values, backed by Chrome storage.</p>
        <div class="card-actions"><button id="kv">Round-trip string + binary</button><button id="kv-clear">Clear demo namespace</button></div>
      </section>
      <section class="module-card" data-module="ChromeRuntime"><h2>ChromeRuntime</h2>
        <p>Inspect extension metadata and send schema-validated messages.</p>
        <div class="card-actions"><button id="metadata">Metadata</button><button id="ping">Schema ping</button></div>
      </section>
      <section class="module-card" data-module="ChromeServiceWorker"><h2>ChromeServiceWorker</h2>
        <p>Synchronous wake listeners, initialization gating, and typed handler failures.</p>
        <div class="card-actions"><button id="status">Worker / lifecycle / last alarm</button><button id="fail">Intentional handler error</button></div>
      </section>
      <section class="module-card" data-module="ChromePort"><h2>ChromePort</h2>
        <p>Own a scoped connection. Wait for the greeting before sending.</p>
        <div class="card-actions"><button id="connect">Connect</button><button id="port-send">Send value</button><button id="disconnect">Disconnect</button></div>
      </section>
      <section class="module-card" data-module="ChromeTabs"><h2>ChromeTabs</h2>
        <p>Inspect tabs or open an example.com target for content messaging.</p>
        <div class="card-actions"><button id="tabs">Query tabs</button><button id="open">Open example.com</button><button id="content">Message content script</button></div>
      </section>
      <section class="module-card" data-module="ChromeAlarms"><h2>ChromeAlarms</h2>
        <p>Schedule a demo alarm; the background wake handler saves its result.</p>
        <div class="card-actions"><button id="alarm-create">Schedule in ~1 minute</button><button id="alarm-query">Query alarm</button><button id="alarm-clear">Clear alarm</button></div>
      </section>
      <section class="module-card" data-module="ChromeRpc"><h2>ChromeRpc</h2>
        <p>Typed requests, failures, stream cancellation and transport boundaries.</p>
        <div class="card-actions"><button id="rpc-demo">Ping / fail / cancel stream</button></div>
      </section>
      <section class="module-card" data-module="ChromeSchemaStorage"><h2>ChromeSchemaStorage</h2>
        <p>Validated entries, version migration and scoped observation.</p>
        <div class="card-actions"><button id="schema-write">Write validated entry</button><button id="schema-migrate">Migrate v0 → v1</button><button id="schema-subscribe">Subscribe</button><button id="schema-stop">Stop subscription</button></div>
      </section>
      <section class="module-card" data-module="ChromePermissions"><h2>ChromePermissions</h2>
        <p>Inspect grants or request optional example.com access from a user click.</p>
        <div class="card-actions"><button id="permissions">Inspect permissions</button><button id="permission-request">Request example.com access</button></div>
      </section>
      <section class="module-card" data-module="ChromeScripting"><h2>ChromeScripting</h2>
        <p>Activate example.com and grant access before injecting the title reader.</p>
        <div class="card-actions"><button id="scripting">Read active page title</button></div>
      </section>
      <section class="module-card" data-module="ChromeSidePanel"><h2>ChromeSidePanel</h2>
        <p>The side panel hosts this playground beside your tabs. Closing it releases its scoped listeners and ports.</p>
        <div class="card-actions"><button id="panel-inspect" disabled>Inspect options / layout</button><button id="panel-close" disabled>Close side panel</button></div>
        <p id="panel-status" role="status">Preparing side panel controls…</p>
      </section>
    </main>
    <p id="no-modules" hidden>No modules match your search.</p>
    <section class="suite-card"><h2>Combined workloads</h2>
      <p>Individual runs live on each module card. These longer runs exercise multiple integrations.</p>
      <div class="card-actions"><button id="stress">Run RPC + storage churn</button><button id="stress-cancel">Cancel churn</button><button id="limits">Run all limits</button></div>
      <label><input type="checkbox" id="limits-notifications"> Include real OS notifications in the limits suite</label>
      <p>Runs use owned test resources and cleanup. Keep this page open until completion. Gesture-only and unavailable operations report skips.</p>
    </section>
    <section class="event-log"><div class="log-heading"><h2>Event log</h2><button id="clear-output">Clear log</button></div>
      <pre id="output" aria-live="polite">Starting…</pre>
    </section>
  `
}
