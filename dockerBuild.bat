docker build -f Dockerfile.client -t anderswestberg/ts-rpc-client .
docker tag ts-rpc-client:latest anderswestberg/ts-rpc-client:latest
docker push anderswestberg/ts-rpc-client:latest
docker build -t anderswestberg/ts-rpc-server .
docker tag ts-rpc-server:latest anderswestberg/ts-rpc-server:latest
docker push anderswestberg/ts-rpc-server:latest