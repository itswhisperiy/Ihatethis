#!/bin/sh
node bot/bot.js &
sleep 3
node selfbot/selfbot.js &
wait
