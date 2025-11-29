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

const app = express();
createServer(app);

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

              if (typeof data.ydoc_state === "string") {
                try {
                  // Check if it's hex format (starts with \x)
                  if (data.ydoc_state.startsWith("\\x")) {
                    // Hex format - this is how Supabase returns bytea
                    // IMPORTANT: Supabase stores our base64 string as text in bytea,
                    // so the hex is actually hex representation of the base64 string, not the binary data
                    // We need to: hex -> base64 string -> binary data
                    const hexString = data.ydoc_state.replace(/^\\x/, "");

                    // Step 1: Decode hex to get the base64 string
                    const base64String = Buffer.from(hexString, "hex").toString(
                      "utf8"
                    );

                    // Step 2: Decode base64 to get the actual binary data
                    const buffer = Buffer.from(base64String, "base64");
                    bytes = new Uint8Array(buffer);

                    return bytes;
                  }
                } catch (decodeError) {
                  console.error(`[Database] Decode error:`, decodeError);
                  return null;
                }
              } else {
                console.warn(
                  `[Database] Unexpected data format for ${documentName}: ${typeof data.ydoc_state}`
                );
                return null;
              }
            } catch (decodeError) {
              console.error(
                `[Database] Error decoding document for ticket ${documentName}:`,
                decodeError
              );
              return null;
            }
          }

          console.log(`[Database] No document data for ticket ${documentName}`);
          return null;
        } catch (error) {
          console.error(
            `[Database] Error fetching document for ticket ${documentName}:`,
            error
          );
          return null;
        }
      },

      store: async ({ documentName, state }) => {
        console.log(
          `[Database] Storing document for ticket: ${documentName} (${state.length} bytes)`
        );

        try {
          // Supabase will handle Buffer as bytea automatically
          const buffer = Buffer.from(state);

          // Convert to base64 for storage (Supabase will convert it to bytea)
          const base64Content = buffer.toString("base64");

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
