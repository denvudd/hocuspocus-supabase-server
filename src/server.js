import "dotenv/config";

import { Server } from "@hocuspocus/server";

import { Database } from "@hocuspocus/extension-database";

import { createClient } from "@supabase/supabase-js";

import express from "express";

import { createServer } from "http";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const DOCUMENTS_TABLE = "ticket_documents";

// Create Express app for health checks
const app = express();
const httpServer = createServer(app);

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Hocuspocus server is running",
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "healthy" });
});

const hocuspocusServer = Server.configure({
  port: process.env.PORT || 3001,

  address: "0.0.0.0",
  extensions: [
    new Database({
      fetch: async ({ documentName }) => {
        console.log(`[Database] Fetching document for ticket: ${documentName}`);

        try {
          const { data, error } = await supabase
            .from(DOCUMENTS_TABLE)
            .select("ydoc_state")
            .eq("ticket_id", documentName)
            .single();

          console.log(`[Database] Query result for ${documentName}:`, {
            hasData: !!data,
            hasError: !!error,
            errorCode: error?.code,
          });

          if (error) {
            if (error.code === "PGRST116") {
              // Document not found - return null to let Hocuspocus create empty document
              // Don't create it here, it will be created on first save
              console.log(
                `[Database] Document for ticket ${documentName} not found, will create on first save`
              );
              return null;
            }
            console.error(
              `[Database] Error fetching document for ticket ${documentName}:`,
              error
            );
            throw error;
          }

          if (data && data.ydoc_state) {
            try {
              let binaryString;

              // Supabase can return bytea in different formats:
              // 1. As base64 string (when using .select())
              // 2. As hex string starting with \x (when stored as bytea)
              // 3. As Buffer (in some cases)

              if (Buffer.isBuffer(data.ydoc_state)) {
                // Already a Buffer
                const bytes = new Uint8Array(data.ydoc_state);
                console.log(
                  `[Database] Document for ticket ${documentName} loaded successfully (Buffer format)`
                );
                return bytes;
              } else if (typeof data.ydoc_state === "string") {
                // Check if it's hex format (starts with \x)
                if (data.ydoc_state.startsWith("\\x")) {
                  // Hex format - convert hex to base64, then to binary
                  const hexString = data.ydoc_state.replace(/^\\x/, "");
                  const buffer = Buffer.from(hexString, "hex");
                  binaryString = buffer.toString("binary");
                } else {
                  // Assume it's base64 string
                  binaryString = atob(data.ydoc_state);
                }
              } else {
                console.warn(
                  `[Database] Unexpected data format for ${documentName}, returning null`
                );
                return null;
              }

              // Convert binary string to Uint8Array
              const bytes = new Uint8Array(binaryString.length);
              for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
              }

              console.log(
                `[Database] Document for ticket ${documentName} loaded successfully (${bytes.length} bytes)`
              );
              return bytes;
            } catch (decodeError) {
              console.error(
                `[Database] Error decoding document for ticket ${documentName}:`,
                decodeError
              );
              // Return null if decoding fails - will create new document
              return null;
            }
          }

          // No data or empty ydoc_state
          console.log(
            `[Database] No document data for ticket ${documentName}, returning null`
          );
          return null;
        } catch (error) {
          console.error(
            `[Database] Error fetching document for ticket ${documentName}:`,
            error
          );
          // Return null on error - Hocuspocus will create empty document
          return null;
        }
      },

      store: async ({ documentName, state }) => {
        console.log(
          `[Database] Storing document for ticket: ${documentName} (${state.length} bytes)`
        );

        try {
          // Convert Uint8Array to binary string, then to base64
          const bytes = new Uint8Array(state);
          let binary = "";
          for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          const base64Content = btoa(binary);

          const { error } = await supabase.from(DOCUMENTS_TABLE).upsert(
            {
              ticket_id: documentName,
              ydoc_state: base64Content,
              updated_at: new Date().toISOString(),
            },
            {
              onConflict: "ticket_id",
            }
          );

          if (error) {
            console.error(
              `[Database] Error storing document for ticket ${documentName}:`,
              error
            );
            throw error;
          }

          console.log(
            `[Database] Document for ticket ${documentName} stored successfully`
          );
        } catch (error) {
          console.error(
            `[Database] Error storing document for ticket ${documentName}:`,
            error
          );
          throw error;
        }
      },
    }),
  ],

  async onConnect({ documentName, requestHeaders }) {
    console.log(`[Server] Client connected to document: ${documentName}`);
  },

  async onDisconnect({ documentName }) {
    console.log(`[Server] Client disconnected from document: ${documentName}`);
  },

  async onUpgrade({ request, socket, head }) {
    console.log("[Server] WebSocket upgrade requested");
  },

  async onChange({ documentName, context }) {
    console.log(`[Server] Document ${documentName} changed`);
  },

  async onDestroy() {
    console.log("[Server] Server destroyed");
  },
});

const PORT = process.env.PORT || 3001;

hocuspocusServer.listen().then(() => {
  console.log(`✅ Hocuspocus server is running on port ${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}`);
  console.log(`   HTTP: http://localhost:${PORT}`);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM signal received: closing server");
  hocuspocusServer.destroy().then(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  console.log("SIGINT signal received: closing server");
  hocuspocusServer.destroy().then(() => {
    console.log("Server closed");
    process.exit(0);
  });
});
