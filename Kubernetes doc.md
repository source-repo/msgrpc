# Using Kubernetes

## Running Minikube on Debian

minikube start
eval $(minikube docker-env)
kubectl apply -f k8s

## Install Minikube on Debian

---------------
sudo apt install curl
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
chmod +x ./kubectl
sudo mv ./kubectl /usr/local/bin/kubectl
kubectl version --client

curl -LO https://storage.googleapis.com/minikube/releases/latest/minikube-linux-amd64
sudo install minikube-linux-amd64 /usr/local/bin/minikube

minikube start
--------------

Minikube will by default run containers in a single VM under Docker. This is recommended.

To build Docker images first run:

Install Helm

----------------
curl -fsSL -o helm-v3.x.x-linux-amd64.tar.gz https://get.helm.sh/helm-v3.x.x-linux-amd64.tar.gz
tar -zxvf helm-v3.x.x-linux-amd64.tar.gz
(Note version names above!!!!!!!!!!!!!!!)

sudo mv linux-amd64/helm /usr/local/bin/helm

helm repo add stable https://charts.helm.sh/stable
helm repo update

-----------------

Apply a single deployment: kubectl apply -f emqx-deployment.yaml
Apply a folder: kubectl apply -f k8s

Get minikube ip (for access from the host): minikube ip

To use locally built Docker images (run every time): eval $(minikube docker-env)
Use name without prefix when building docker image
To unset this: eval $(minikube docker-env -u)

In deployment: imagePullPolicy: IfNotPresent

For some reason minikube works better in vscode terminal than a simple terminal (gives permission error).

Remember to use service name in url:s, not deployment name

To delete things and start over:
kubectl delete deployments --all
kubectl delete services --all
