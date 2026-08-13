#!/bin/sh

set -e

TEMP_CONFIG="/tmp/config.json"

# Resolve and output the below variables to /tmp/config.json
node /usr/app/dist/src/entrypoint-config.js
export TZ=$(cat $TEMP_CONFIG | jq -r ".timezone")
RUN_ON_STARTUP=$(cat $TEMP_CONFIG | jq -r ".runOnStartup")
RUN_ONCE=$(cat $TEMP_CONFIG | jq -r ".runOnce")
CRON_SCHEDULE=$(cat $TEMP_CONFIG | jq -r ".cronSchedule")
# PATCH (hang timeout): o game coordinator pode travar no "Requesting game
# data" sem timeout (conexão com a Valve). Com cron ativo (runOnce=false),
# um run preso nunca morre e o próximo tick dispara um segundo processo
# concorrente escrevendo no mesmo store.json. O `timeout` mata o run após
# RUN_TIMEOUT_SEC (default 3600s = 1h), deixando o próximo tick rodar limpo.
# Substitui a necessidade do watchdog externo de restart.
RUN_TIMEOUT_SEC="${RUN_TIMEOUT_SEC:-3600}"

# If runOnStartup is set, run it once before setting up the schedule
echo "Run on startup: ${RUN_ON_STARTUP}"
if [ "$RUN_ON_STARTUP" = "true" ]; then
    timeout "${RUN_TIMEOUT_SEC}" node /usr/app/dist/src/index.js
fi

# If runOnce is not set, schedule the process
echo "Run once: ${RUN_ONCE}"
if [ "$RUN_ONCE" = "false" ]; then
    echo "Setting cron schedule as ${CRON_SCHEDULE}"
    # Add the command to the crontab
    echo "${CRON_SCHEDULE} timeout ${RUN_TIMEOUT_SEC} node /usr/app/dist/src/index.js" > $HOME/crontab
    # Run the cron process. The container should halt here and wait for the schedule.
    supercronic -passthrough-logs $HOME/crontab
fi
echo "Exiting..."
