# The Railway cron service "[KT-01] meeting-uploads-cron": once an hour it asks the bot to post the new client
# meetings from Fireflies (app/api/cron/meeting-uploads). Railway builds it from GitHub on every push that changes
# cron/ (service settings: Dockerfile path cron/Dockerfile, watch path cron/**, cron "0 * * * *", never restart).
# Needs JOB_URL (the bot's /api/cron/meeting-uploads) and CRON_SECRET (the same value as on the bot).
FROM curlimages/curl:8.11.1
CMD ["sh", "-c", "curl -fsS --max-time 290 -X POST -H \"Authorization: Bearer $CRON_SECRET\" \"$JOB_URL\""]
