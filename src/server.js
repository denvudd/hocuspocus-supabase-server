import 'dotenv/config';
import { Server } from '@hocuspocus/server';
import { Database } from '@hocuspocus/extension-database';
import { createClient } from '@supabase/supabase-js';
import express from 'express';
import { createServer } from 'http';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const DOCUMENTS_TABLE = 'ticket_documents';

// Create Express app for health checks
const app = express();
const httpServer = createServer(app);

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Hocuspocus server is running',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

const hocuspocusServer = Server.configure({
  port: process.env.PORT || 3001,
  
  address: '0.0.0.0',

  extensions: [
    new Database({
      fetch: async ({ documentName }) => {
        console.log(`Fetching document for ticket: ${documentName}`);
        
        try {
          const { data, error } = await supabase
            .from(DOCUMENTS_TABLE)
            .select('ydoc_state')
            .eq('ticket_id', documentName)
            .single();
          console.log("🚀 ~ data:", data)

          if (error) {
            if (error.code === 'PGRST116') {
              console.log(`Document for ticket ${documentName} not found, will create new`);
              return null;
            }
            throw error;
          }

          if (data && data.ydoc_state) {
            const binaryString = atob(data.ydoc_state);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            console.log(`Document for ticket ${documentName} loaded successfully`);
            return bytes;
          }

          return null;
        } catch (error) {
          console.error(`Error fetching document for ticket ${documentName}:`, error);
          return null;
        }
      },

      store: async ({ documentName, state }) => {
        console.log(`Storing document for ticket: ${documentName}`);
        
        try {
          let binary = '';
          const bytes = new Uint8Array(state);
          for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          const base64Content = btoa(binary);

          const { error } = await supabase
            .from(DOCUMENTS_TABLE)
            .upsert({
              ticket_id: documentName,
              ydoc_state: base64Content,
              updated_at: new Date().toISOString()
            }, {
              onConflict: 'ticket_id'
            });

          if (error) {
            console.error(`Error storing document for ticket ${documentName}:`, error);
            throw error;
          }

          console.log(`Document for ticket ${documentName} stored successfully`);
        } catch (error) {
          console.error(`Error storing document for ticket ${documentName}:`, error);
          throw error;
        }
      }
    })
  ],

  async onConnect({ documentName, requestHeaders }) {
    console.log(`Client connected to document: ${documentName}`);
  },

  async onDisconnect({ documentName }) {
    console.log(`Client disconnected from document: ${documentName}`);
  },

  async onUpgrade({ request, socket, head }) {
    console.log('WebSocket upgrade requested');
  },

  async onChange({ documentName, context }) {
    console.log(`Document ${documentName} changed`);
  },

  async onDestroy() {
    console.log('Server destroyed');
  }
});

const PORT = process.env.PORT || 3001;

hocuspocusServer.listen().then(() => {
  console.log(`✅ Hocuspocus server is running on port ${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}`);
  console.log(`   HTTP: http://localhost:${PORT}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing server');
  hocuspocusServer.destroy().then(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing server');
  hocuspocusServer.destroy().then(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

