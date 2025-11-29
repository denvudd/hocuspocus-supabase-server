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
createServer(app); // HTTP server for health checks

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
          // Try to get bytea as base64 string
          // Supabase automatically converts bytea to base64 when using .select()
          const { data, error } = await supabase
            .from(DOCUMENTS_TABLE)
            .select("ydoc_state")
            .eq("ticket_id", documentName)
            .single();

          console.log(`[Database] Query result for ${documentName}:`, {
            hasData: !!data,
            hasError: !!error,
            errorCode: error?.code,
            dataType: data?.ydoc_state ? typeof data.ydoc_state : "no data",
            dataLength: data?.ydoc_state
              ? typeof data.ydoc_state === "string"
                ? data.ydoc_state.length
                : "non-string"
              : 0,
            dataPreview: data?.ydoc_state
              ? typeof data.ydoc_state === "string"
                ? data.ydoc_state.substring(0, 100)
                : "non-string"
              : "no data",
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
              let bytes;

              // Log the actual type and first few characters for debugging
              const dataType = typeof data.ydoc_state;
              const preview =
                typeof data.ydoc_state === "string"
                  ? data.ydoc_state.substring(0, 50)
                  : "non-string";
              console.log(
                `[Database] Data type: ${dataType}, preview: ${preview}`
              );

              // Supabase returns bytea as base64-encoded string when using .select()
              // We stored it as base64, so we need to decode it
              if (Buffer.isBuffer(data.ydoc_state)) {
                // Already a Buffer - convert directly
                bytes = new Uint8Array(data.ydoc_state);
                console.log(
                  `[Database] Document for ticket ${documentName} loaded successfully (Buffer format, ${bytes.length} bytes)`
                );
                return bytes;
              } else if (typeof data.ydoc_state === "string") {
                // Supabase returns bytea as base64 string when using .select()
                // We stored it as base64, so we need to decode it properly
                try {
                  // Check if it looks like base64 (alphanumeric + / + =)
                  const isBase64 = /^[A-Za-z0-9+/]*={0,2}$/.test(
                    data.ydoc_state
                  );

                  if (isBase64) {
                    // Decode base64 to Buffer, then to Uint8Array
                    const buffer = Buffer.from(data.ydoc_state, "base64");
                    bytes = new Uint8Array(buffer);

                    console.log(
                      `[Database] Document for ticket ${documentName} loaded successfully (base64 decoded, ${bytes.length} bytes)`
                    );
                    console.log(
                      `[Database] First 10 bytes: ${Array.from(
                        bytes.slice(0, 10)
                      ).join(",")}`
                    );
                    return bytes;
                  } else {
                    // Not base64 - might be hex or raw binary
                    console.log(
                      `[Database] Data doesn't look like base64, trying hex decode`
                    );
                    // Try hex decode
                    if (data.ydoc_state.startsWith("\\x")) {
                      const hexString = data.ydoc_state.replace(/^\\x/, "");
                      const buffer = Buffer.from(hexString, "hex");
                      bytes = new Uint8Array(buffer);
                      console.log(
                        `[Database] Document for ticket ${documentName} loaded successfully (hex decoded, ${bytes.length} bytes)`
                      );
                      return bytes;
                    } else {
                      // Try as raw binary string
                      bytes = new Uint8Array(data.ydoc_state.length);
                      for (let i = 0; i < data.ydoc_state.length; i++) {
                        bytes[i] = data.ydoc_state.charCodeAt(i);
                      }
                      console.log(
                        `[Database] Document for ticket ${documentName} loaded successfully (raw binary, ${bytes.length} bytes)`
                      );
                      return bytes;
                    }
                  }
                } catch (decodeError) {
                  console.error(`[Database] Decode error:`, decodeError);
                  // If decoding fails, return null to create new document
                  return null;
                }
              } else {
                console.warn(
                  `[Database] Unexpected data format for ${documentName}: ${typeof data.ydoc_state}, returning null`
                );
                return null;
              }
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
          // Convert Uint8Array to Buffer, then to base64
          // This ensures proper encoding for Supabase bytea field
          const buffer = Buffer.from(state);
          const base64Content = buffer.toString("base64");

          console.log(
            `[Database] Encoded to base64: ${base64Content.substring(0, 50)}...`
          );

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

  async onConnect({ documentName }) {
    console.log(`[Server] Client connected to document: ${documentName}`);
  },

  async onDisconnect({ documentName }) {
    console.log(`[Server] Client disconnected from document: ${documentName}`);
  },

  async onUpgrade() {
    console.log("[Server] WebSocket upgrade requested");
  },

  async onChange({ documentName }) {
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
