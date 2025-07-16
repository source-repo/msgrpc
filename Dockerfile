# Use an official Node runtime as a parent image
FROM node:18

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy the current directory contents into the container at /usr/src/app
COPY . .

# Install any needed packages specified in package.json
RUN npm install
RUN npm run build

# Make port 3000 available to the world outside this container
EXPOSE 3000

# Define environment variable
ENV PORT 3000

# Run app.js when the container launches
CMD ["node", "--inspect=0.0.0.0:9229", "./dist/examples/nodejs-server/NodeServerTest.js"]
SHELL ["/bin/bash", "-c"]