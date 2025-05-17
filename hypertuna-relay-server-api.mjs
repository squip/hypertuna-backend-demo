// this is the script for /backend/hypertuna-relay-server-api.mjs
// This file adds API endpoints to the existing hypertuna-relay-server.mjs

import express from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Get the directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { dirname } from 'node:path';

// Function to add API capabilities to your existing relay server
export function setupApiIntegration(app, config, activeRelays, healthState, 
  { createRelay, joinRelay, registerWithGateway, publicKey, hyperteleServer, hyperdriveProcess }) {
  
  // Store logs for API access
  const logEntries = [];
  const MAX_LOG_ENTRIES = 200;
  
  // Intercept console.log to store logs
  const originalConsoleLog = console.log;
  console.log = function(...args) {
    originalConsoleLog.apply(console, args);
    
    // Format the log entry
    const timestamp = new Date().toISOString();
    const message = args.map(arg => 
      typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
    ).join(' ');
    
    // Store in our log buffer
    logEntries.push({ timestamp, message });
    
    // Keep log buffer at MAX_LOG_ENTRIES
    if (logEntries.length > MAX_LOG_ENTRIES) {
      logEntries.shift();
    }
  };
  
  // Create a public directory for serving static files if it doesn't exist
  const setupPublicDir = async () => {
    const publicDir = path.join(__dirname, 'public');
    try {
      await fs.mkdir(publicDir, { recursive: true });
    } catch (err) {
      console.log(`Error creating public directory: ${err.message}`);
    }
    
    // Add the UI file
    try {
      const uiFilePath = path.join(publicDir, 'index.html');
      await fs.writeFile(uiFilePath, await fs.readFile('./hypertuna-ui.html', 'utf8'));
      console.log(`UI file copied to ${uiFilePath}`);
    } catch (err) {
      console.log(`Note: UI file not copied: ${err.message}`);
    }
    
    return publicDir;
  };
  
  // Setup CORS middleware
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    
    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }
    
    next();
  });
  
  // Serve static files from public directory
  setupPublicDir().then(publicDir => {
    app.use(express.static(publicDir));
  });
  
  // API Routes
  
  // Get logs
  app.get('/logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const recentLogs = logEntries.slice(-Math.min(limit, MAX_LOG_ENTRIES));
    res.json(recentLogs);
  });
  
  // Get relay list with connection URLs
  app.get('/relays', (req, res) => {
    const relayList = Array.from(activeRelays.keys()).map(relayKey => {
      return {
        relayKey,
        connectionUrl: `wss://${config.proxy_server_address}/${relayKey}`
      };
    });
    
    res.json({
      relays: relayList,
      count: relayList.length
    });
  });
  
  // Create a new relay (API endpoint)
  app.post('/relay/create', async (req, res) => {
    try {
      const { name, description, storageDir } = req.body;
      
      if (!name) {
        return res.status(400).json({ error: 'Relay name is required' });
      }
      
      // Create a relay profile info object
      const relayProfileInfo = {
        name,
        description: description || '',
        pubkey: config.nostr_pubkey_hex 
      };
      
      // Call the existing createRelay function with the relay profile info
      const relayKey = await createRelay(storageDir, relayProfileInfo);
      
      if (relayKey) {
        res.json({
          success: true,
          relayKey,
          connectionUrl: `wss://${config.proxy_server_address}/${relayKey}`,
          message: `Relay '${name}' created successfully`
        });
      } else {
        res.status(500).json({ error: 'Failed to create relay' });
      }
    } catch (error) {
      console.log(`Error creating relay via API: ${error.message}`);
      res.status(500).json({ error: error.message });
    }
  });
  
  // Join an existing relay (API endpoint)
  app.post('/relay/join', async (req, res) => {
    try {
      const { relayKey, storageDir } = req.body;
      
      if (!relayKey) {
        return res.status(400).json({ error: 'Relay key is required' });
      }
      
      // Call the existing joinRelay function
      const joinedRelayKey = await joinRelay(relayKey, storageDir);
      
      if (joinedRelayKey) {
        res.json({
          success: true,
          relayKey: joinedRelayKey,
          connectionUrl: `wss://${config.proxy_server_address}/${joinedRelayKey}`,
          message: `Joined relay with key ${joinedRelayKey} successfully`
        });
      } else {
        res.status(500).json({ error: 'Failed to join relay' });
      }
    } catch (error) {
      console.log(`Error joining relay via API: ${error.message}`);
      res.status(500).json({ error: error.message });
    }
  });
  
  // Get detailed health stats (enhancement of existing /health endpoint)
  app.get('/health/details', (req, res) => {
    try {
      const now = Date.now();
      
      // Create a safer way to access properties that might not exist
      const safeGet = (obj, path, defaultValue) => {
        if (!obj) return defaultValue;
        
        const keys = path.split('.');
        let result = obj;
        
        for (const key of keys) {
          if (result === undefined || result === null) return defaultValue;
          result = result[key];
        }
        
        return result !== undefined && result !== null ? result : defaultValue;
      };
      
      // Safely get active peers (making sure we don't crash if activePeers is undefined)
      const activeRelayList = [];
      try {
        // Only attempt to iterate if activeRelays exists and is a Map
        if (activeRelays && typeof activeRelays.keys === 'function') {
          for (const relayKey of activeRelays.keys()) {
            try {
              const relayData = activeRelays.get(relayKey);
              const peerList = [];
              
              // Safely handle peers collection
              if (relayData && relayData.peers && typeof relayData.peers.forEach === 'function') {
                relayData.peers.forEach(peerKey => {
                  try {
                    // Find the peer in activePeers if it exists
                    const peer = Array.isArray(activePeers) ? 
                      activePeers.find(p => p && p.publicKey === peerKey) : null;
                    
                    if (peer) {
                      // Safely get health status
                      let status = 'unknown';
                      if (peerHealthManager && peerHealthManager.healthChecks) {
                        const healthCheck = peerHealthManager.healthChecks.get(peerKey);
                        if (healthCheck) {
                          status = healthCheck.status || 'unknown';
                        }
                      }
                      
                      peerList.push({
                        publicKey: peer.publicKey,
                        status: status,
                        lastSeen: peer.lastSeen || 0
                      });
                    }
                  } catch (peerError) {
                    console.log(`Error processing peer ${peerKey}: ${peerError.message}`);
                    // Don't crash, just continue to the next peer
                  }
                });
              }
              
              activeRelayList.push({
                relayKey,
                connectionUrl: `wss://${safeGet(config, 'proxy_server_address', 'localhost')}/${relayKey}`,
                peerCount: peerList.length,
                peers: peerList
              });
            } catch (relayError) {
              console.log(`Error processing relay ${relayKey}: ${relayError.message}`);
              // Don't crash, just continue to the next relay
            }
          }
        }
      } catch (relaysError) {
        console.log(`Error processing relays: ${relaysError.message}`);
        // Don't crash the whole response
      }
      
      // Safely prepare peer metrics
      let peerMetrics = {
        totalChecks: 0,
        failedChecks: 0,
        recoveredPeers: 0,
        healthyPeers: 0,
        unhealthyPeers: 0,
        circuitsBroken: 0,
        lastReset: now
      };
      
      try {
        if (peerHealthManager) {
          // Get counts of healthy/unhealthy peers and circuits broken
          let healthyCount = 0;
          let unhealthyCount = 0;
          let circuitsBrokenCount = 0;
          
          if (peerHealthManager.healthChecks && typeof peerHealthManager.healthChecks.values === 'function') {
            for (const check of peerHealthManager.healthChecks.values()) {
              if (check) {
                if (check.status === 'healthy') healthyCount++;
                else unhealthyCount++;
                
                if (check.circuitBroken) circuitsBrokenCount++;
              }
            }
          }
          
          peerMetrics = {
            totalChecks: safeGet(peerHealthManager, 'metrics.totalChecks', 0),
            failedChecks: safeGet(peerHealthManager, 'metrics.failedChecks', 0),
            recoveredPeers: safeGet(peerHealthManager, 'metrics.recoveredPeers', 0),
            healthyPeers: healthyCount,
            unhealthyPeers: unhealthyCount,
            circuitsBroken: circuitsBrokenCount,
            lastReset: safeGet(peerHealthManager, 'metrics.lastMetricsReset', now)
          };
        }
      } catch (metricsError) {
        console.log(`Error processing peer metrics: ${metricsError.message}`);
        // Don't crash the whole response
      }
      
      // Create a safe response object with default values
      const detailedHealth = {
        status: safeGet(healthState, 'status', 'unknown'),
        uptime: now - safeGet(healthState, 'startTime', now),
        activeRelays: {
          count: activeRelayList.length,
          items: activeRelayList
        },
        services: {
          hypertele: safeGet(healthState, 'services.hyperteleStatus', 'unknown'),
          hyperdrive: safeGet(healthState, 'services.hyperdriveStatus', 'unknown'),
          webserver: safeGet(healthState, 'services.webserver', 'unknown')
        },
        metrics: {
          totalRequests: safeGet(healthState, 'metrics.totalRequests', 0),
          successfulRequests: safeGet(healthState, 'metrics.successfulRequests', 0),
          failedRequests: safeGet(healthState, 'metrics.failedRequests', 0),
          successRate: safeGet(healthState, 'metrics.totalRequests', 0) === 0 ? 
            100 : 
            (safeGet(healthState, 'metrics.successfulRequests', 0) / 
             safeGet(healthState, 'metrics.totalRequests', 1)) * 100,
          peers: peerMetrics
        },
        host: safeGet(config, 'proxy_server_address', 'localhost'),
        publicKey: publicKey || 'unknown',
        gatewayUrl: safeGet(config, 'gatewayUrl', 'unknown'),
        lastCheck: safeGet(healthState, 'lastCheck', now),
        timestamp: new Date().toISOString()
      };
      
      // Send the response
      res.json(detailedHealth);
      
    } catch (error) {
      // Catch any unexpected errors and return a generic error response
      console.log(`Error getting detailed health stats: ${error.message}`);
      console.log(error.stack);
      
      res.status(500).json({ 
        error: `Internal server error: ${error.message}`,
        status: 'error',
        simpleStatus: 'error',
        timestamp: new Date().toISOString()
      });
    }
  });
  
  // Trigger registration with gateway
  app.post('/register-with-gateway', (req, res) => {
    try {
      registerWithGateway();
      res.json({ 
        success: true, 
        message: 'Registration with gateway initiated',
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.log(`Error triggering gateway registration: ${error.message}`);
      res.status(500).json({ error: error.message });
    }
  });
  
  // Update configuration (without restarting)
  app.post('/config/update', async (req, res) => {
    try {
      const updatedConfig = req.body;
      
      if (!updatedConfig) {
        return res.status(400).json({ error: 'Configuration is required' });
      }
      
      // Save the updated configuration to a file
      const configPath = path.join(__dirname, 'config-updated.json');
      await fs.writeFile(configPath, JSON.stringify(updatedConfig, null, 2));
      
      res.json({ 
        success: true, 
        message: 'Configuration updated and saved to config-updated.json. Note: Some changes may require a restart.',
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.log(`Error updating configuration: ${error.message}`);
      res.status(500).json({ error: error.message });
    }
  });
  
  console.log('API integration setup complete - endpoints available at /health/details, /logs, /relays, /relay/create, /relay/join');
}
