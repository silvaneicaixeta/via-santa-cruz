import { createClient } from "@supabase/supabase-js";
import { createHandler } from "./core.mjs";

const url=Deno.env.get("SUPABASE_URL");
const service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
// Dedicated random secret, installed only server-side after approval.
// verify_jwt=false is required for this route; the handler authenticates BOTH paths.
const automaticSecret=Deno.env.get("VSC_AGENDA_SYNC_TOKEN") || "";
if (!url || !service) throw new Error("server_configuration");
const db=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}});
Deno.serve(createHandler(db,automaticSecret));
