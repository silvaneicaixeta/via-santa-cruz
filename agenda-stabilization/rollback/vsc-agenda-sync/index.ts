// PREPARED emergency containment only. Deploy exclusively after approval.
// Does not initialize a privileged client or access calendars/database.
Deno.serve(() => Response.json({error:"sync_maintenance"}, {
 status:503,headers:{"Cache-Control":"no-store"},
}));
