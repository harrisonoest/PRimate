#!/bin/bash

docker stop $(docker ps -aqf "name=primate") | xargs docker rm