# Steam Link Bot Pro

This is a modular upgrade of the original single-file bot.

## Keeps your existing features
- /link
- /unlinksteam
- /mylink
- /refreshsteam
- /verifiedlist
- /adminsetsteam
- /adminunlinksteam
- /forcesyncsteam
- /bulkimport
- startup sync
- interval sync
- restore on rejoin
- verify-channel message auto-delete

## Adds
- safer command registration (non-fatal if Discord command registration fails)
- audit logs
- /verifyhelp
- /steamstats
- /findsteam
- /userlink
- /syncusersteam
- /restoreverified
- /orphanlinks
- /recentactions
- /exportlinks
- /unlinkbysteam
- /setbasenick
- /resetbasenick
- /renickname
- /setlinknote
- Steam API retry logic
- graceful shutdown

## Optional env vars
- VERIFY_CHANNEL_AUTODELETE_SECONDS
- STEAM_API_RETRY_COUNT
- MAX_BULKIMPORT_LINES
- AUDIT_LOG_RETENTION_DAYS
- MAX_EXPORT_ROWS
- DB_PATH
