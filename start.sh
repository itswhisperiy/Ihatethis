#!/bin/sh
node bot.js &
sleep 3
node selfbot.js &
wait
