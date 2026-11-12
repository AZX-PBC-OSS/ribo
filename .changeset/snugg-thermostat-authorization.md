---
"@azx/ribo-adapter-snuggpro": patch
---

Refresh the Snugg Pro endpoint table from the live vendor spec: the report upsert now accepts `pageThermostatAuthorization`, `titleThermostatAuthorization`, `pageThermostatAuthorizationSigned` and `titleThermostatAuthorizationSigned`. The extraction schema is unchanged, so nothing new is sent unless a host supplies those values.
