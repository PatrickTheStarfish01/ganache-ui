const { CordaBootstrap } = require("./bootstrap");
const { EventEmitter } = require("events");
const { basename, join } = require("path");
const postgres = require("../postgres");
const Braid = require("./braid");
const Corda = require("./corda");
const fse = require("fs-extra");
const { Client } = require("pg");
const fetch = require("node-fetch");
const GetPort = require("get-port");
const BlobInspector = require("./blob-inspector");

const https = require("https");
const agent = new https.Agent({
  rejectUnauthorized: false
});

class IO {
  constructor(context){
    const createMsgEmitter = (...args) => context.emit.bind(context, "message", ...args);
    this.sendProgress = createMsgEmitter("progress");
    this.sendError = createMsgEmitter("error");
    this.sendStdErr = createMsgEmitter("stderr");
    this.sendStdOut = createMsgEmitter("stdout");
  }
}

class NetworkManager extends EventEmitter {
  constructor (config, settings, workspaceDirectory) {
    super();
    this.config = config;
    this.settings = settings;
    this.workspaceDirectory = workspaceDirectory;
    this.nodes = [];
    this.notaries = [];
    this.processes = [];
    this._io = new IO(this);
    this.postGresHooksPromise = null;
    this.blacklist = new Set();
    this._downloadPromise = null;
    this.blobInspector = null;
  }

  async bootstrap(nodes, notaries, postgresPort) {
      // kick off downloading all the things ASAP! this is safe to do because
      // each individual file that is downloaded is a singleton, returning the
      // same promise for each file request, or it jsut returns immediately if
      // the file is already downloaded
      this._downloadPromise = this.config.corda.downloadAll();

      const BRAID_HOME = this.config.corda.files.braidServer.download();
      const POSTGRES_HOME = this.config.corda.files.postgres.download();
      this._io.sendProgress("Writing configuration files...");
      const cordaBootstrap = new CordaBootstrap(this.workspaceDirectory, this._io);
      const {nodesArr, notariesArr} = await cordaBootstrap.writeConfig(nodes, notaries, postgresPort);
      this.nodes = nodesArr;
      this.notaries = notariesArr;
      this.entities = this.nodes.concat(this.notaries);
      this._io.sendProgress("Configuring and starting PostgreSQL...");
      this.pg = postgres(await POSTGRES_HOME).start(postgresPort, this.workspaceDirectory, this.entities, this.settings.isDefault);
      this._io.sendProgress("Bootstrapping network...");
      await cordaBootstrap.bootstrap(this.config);
      this._io.sendProgress("Configuring Postgres Hooks...");
      this.postGresHooksPromise = this.setupPostGresHooks();
      this._io.sendProgress("Copying Cordapps...");
      await Promise.all([
        this.postGresHooksPromise,
        this.copyCordappsAndSetupNetwork()
      ]);
      this._io.sendProgress("Configuring RPC Manager...");
      this.braid = new Braid(join(await BRAID_HOME, ".."), this._io);
  }

  setupPostGresHooks() {
    return Promise.all(this.entities.map(async entity => {
      const client = new Client({
        user: "postgres",
        host: "localhost",
        database: entity.safeName,
        password: "",
        port: this.settings.postgresPort
      })
    
      await client.connect();
      
      await client.query(`create or replace function notify_subscribers()
          returns trigger
          language plpgsql
        AS $$
        begin
          PERFORM pg_notify('my_events', '');
          return null;
        end
        $$;
    
        DROP TRIGGER IF EXISTS mytrigger on public.vault_states;
    
        CREATE TRIGGER mytrigger
        AFTER INSERT OR UPDATE ON vault_states
        FOR EACH ROW
        EXECUTE PROCEDURE notify_subscribers();`);
    
      // Listen for all pg_notify channel messages
      client.on("notification", (msg) => {
        this.emit("message", "send", "VAULT_DATA", msg);
      });
      
      await client.query("LISTEN my_events");
    
      return client;
    }));
  }

  async copyCordappsAndSetupNetwork() {
    const promises = [];
    const networkMap = new Map();
   this.entities.forEach((node) => {
      this.blacklist.add(node.rpcPort);
      this.blacklist.add(node.adminPort);
      this.blacklist.add(node.p2pPort);

      const currentDir = join(this.workspaceDirectory, node.safeName);
      (node.cordapps || []).forEach(path => {
        const name = basename(path);
        const newPath = join(currentDir, "cordapps", name);
        promises.push(fse.copy(path, newPath));
      });
      const info = fse.readdirSync(currentDir).filter(file => file.startsWith("nodeInfo-")).reduce((p, name) => name, "");
      const knownNodesDir = join(currentDir, "additional-node-infos");
      const currentlyKnownNodes = fse.readdirSync(knownNodesDir).map(file => ({file, path: join(knownNodesDir, file)}));
      networkMap.set(node.safeName, {nodes: node.nodes || [], info, currentlyKnownNodes});
    });
    networkMap.forEach((val, _key, nMap) => {
      const needed = new Set([val.info, ...val.nodes.map((node) => nMap.get(node).info)]);
      val.currentlyKnownNodes.forEach(node => {
        if (!needed.has(node.file)) {
          promises.push(fse.remove(node.path));
        }
    });
    });
    return Promise.all(promises);      
  }

  async getPort(port){
    while (this.blacklist.has(port)) port++;
    do {
      port = await GetPort({port});
    } while (this.blacklist.has(port) && port++);
    this.blacklist.add(port);
    return port;
  }

  async start(){
    // TODO: Optimus prime
      const entities = this.entities;
      this._io.sendProgress("Loading JRE...");
      const JAVA_HOME = await this.config.corda.files.jre.download();

      this._io.sendProgress("Starting Corda Nodes...");
      let startedNodes = 0;
      const promises = entities.map(async (entity) => {
        const currentPath = join(this.workspaceDirectory, entity.safeName);
        // eslint-disable-next-line require-atomic-updates
        entity.braidPort = await this.getPort(entity.rpcPort + 20000);
        const braidPromise = this.braid.start(entity, currentPath, JAVA_HOME);
        const corda = new Corda(entity, currentPath, JAVA_HOME, this._io);
        this.processes.push(corda);
        const cordaProm = corda.start();
        cordaProm.then(() => {
          this._io.sendProgress(`Corda node ${++startedNodes}/${entities.length} online...`);
        });
        await Promise.all([cordaProm, braidPromise]);
        // we need to get the `owningKey` for this node so we can reference it in the front end
        // eslint-disable-next-line require-atomic-updates
        entity.owningKey = await fetch("https://localhost:" + entity.braidPort + "/api/rest/network/nodes/self", {agent})
          .then(r => r.json())
          .then(self => self.legalIdentities[0].owningKey);
      });

      await Promise.all(promises);
      // _downloadPromise was started long ago, we just need to make sure all
      //  deps are downloaded before we start up.
      this._io.sendProgress(`Downloading remaining Corda dependencies...`);
      this.blobInspector = new BlobInspector(JAVA_HOME, await this.config.corda.files.blobInspector.download());
  }

  async stop() {
    try {
      if (this.postGresHooksPromise) {
        const postGresHooksClient = await this.postGresHooksPromise;
        try {
          postGresHooksClient && await Promise.all(postGresHooksClient.map(client => client.end()));
          this.postGresHooksPromise = null;
        } catch(e) {
          console.error(e);
        }
      }
      this.pg && await this.pg.stop();
      this.pg = null;
    } catch(e) {
      console.error("Error occured while attempting to stop postgres...");
      console.error(e);
    }

    const promises = this.processes.map(cordaProcess => cordaProcess.stop());

    if (this.braid) {
      promises.push(this.braid.stop());
    }

    return Promise.all(promises);
  }
  
  getNodes(){
    return this.nodes;
  }

  getNotaries(){
    return this.notaries;
  }
}

module.exports = NetworkManager;
