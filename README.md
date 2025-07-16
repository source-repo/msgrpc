# @source-repo/msgrpc

Modular TypeScript communications and RPC system. Use msgrpc to communicate between Node.JS instances, or between a browser page and a server.

`npm install @source-repo/msgrpc`

msgrpc works best with TypeScript, but plain JavaScript works although it is more error prone.

# High level interface

## RPC server

Start by creating a server in NodeJS. The first example here uses the default transport WebSocket (socket.io) on port 3000.

```typescript
const rpcServer = new RpcServer()
```

Add some RPC functionality

```typescript
class TestRpc {
  async square(n: number) {
    return n * n
  }
}

const testRpc = new TestRpc()
rpcServer.exposeClassInstance(testRpc, 'testRpc')
```



## RPC client

The create a RPC client in another NodeJS app, a web app or the same NodeJS app (for testing).

```typescript
const rpcClient = new RpcClient()
await rpcClient.ready()
```

Now get a proxy for the server functionality

```typescript
const proxy = await rpcClient.proxy<TestRpc>('testRpc')
```

And finally call the server method

```typescript
proxy.remote.square(3)
```

# Advanced usage

A RPC server can have multiple transports defined in an optional RpcServerOptions object. This can make the RPC functionality available on multiple WebSocket channels and also via MQTT messaging.

When using MQTT a network of RPC clients and servers can be easily realized. The different servers are addressed using their `name` property.

```typescript
interface RpcServerOptions {   
    name: string
    transports: (HttpServerOptions | ExternalServerOptions | MqttServerOptions | GenericModule)[]
    useMsgPack: boolean
}
```

name: The server name used when routing RPC messages

transports: An array of one or more transport methods:

```typescript
export interface ServerOptions {
    description: string
}

export interface HttpServerOptions extends ServerOptions {
    port: number
    https: boolean
    path: string
}

export interface ExternalServerOptions extends ServerOptions {
    server: Server
    path: string
}

export interface MqttServerOptions extends ServerOptions {
    brokerurl: string
}
```

useMsgPack: MsgPack is default, set to `false` for JSON

# Low level interface

Additional transports, message formats and connections can be implemented using msgrpc Modules.

## Modules

msgrpc works by plugging together modules in order to solve the desired messaging task.

A module can receive, process and send messages. In this context, *sending* does not mean that it goes over a network, but rather from one module to another within the same environment. Also, a *message* in this context can be any JavaScript value - not just strings or binary data. 

By creating a chain of modules by combining the included modules, as well as creating new ones if needed, you can create a customized solution.

### Using modules

A module must implement the base IGenericModule interface. This interface declares a *receive* function which, as the name suggests, is the function that you want to call whenever the module should receive a message. 

So, to send a message to a module, you would call the *receive* function on that module. In reality you would usually not call this function directly - you would instead *pipe* two modules together.

#### Piping

Modules also have a function named *pipe*. This function will tell the module that it should send its messages to the module passed as parameter, effectively creating a connection from one module to the next.

```typescript
let module1 = new MyModule()
let module2 = new MyModule()
module1.pipe(module2)
```

In this example, when module1 sends a message, it reaches out to module2 and calls its *receive* function, along with the message.

There is also a shorthand for this:

```typescript
let module1 = new MyModule()
let module2 = new MyModule([module1])
```

This example is exactly the same as the one above, but shorter.

You can also pipe a module into a function. The function will be called for each message that the module wants to send.

```typescript
let module1 = new MyModule()
module1.pipe((message) => {
    console.log('module1 wanted to send: ', message)
})
```

### Exceptions

When a module receives a message and an exception is thrown, it is propagated back each pipe, back to the original sender. You can catch these errors either at the original sender when calling `this.send`, or by using the TryCatch module.

```typescript
let module1 = new MyModule()
let tryCatch = new TryCatch([module1])
let module2 = new ModuleThatThrows([module2])

tryCatch.on('caught', (message, err) => {
    console.log('The error was caught!')
})
```

In this example, if module2 would throw an exception, the error would not be propagated back to module1. Instead, the event listener would fire and we would see an output in our log.

The receive function of a module can be asynchronous (return a Promise), and if the promise rejects, it would also be propagated in the same way as an exception would.

### Creating modules

To create a module, extend the base GenericModule class (or technically, the base IGenericModule interface). The base class takes care of piping.

To send a message from your module to all pipes, use `this.send(message)`. This is a protected method only accessible from within the module instance.

Take a look within the source code for examples on how to create modules.

### Utility modules

There are a few basic utility modules included with msgrpc. These are:

- **Converter** - Takes a function as a parameter. For each received message, the function is called and the return value is sent to each piped module.
- **Filter** - Takes a function which returns a boolean as a parameter. For each received message, the function is called and if the function returns a true, the message is sent to each piped module. If not, the message is not sent.
- **Switch**  - Allows messages to be sent to a specific target.
- **Targeter** - Adds a target to a message (suitable for sending to a switch).
- **TryCatch** - Catches exceptions (more above).

There are also a few more complex modules included:

- **RpcServer / RpcClient** - Remote procedure call.
- **SocketIoTransport** - WebSocket for both Node.JS and the browser.
- **MqttTransport** - MQTT transport

### WebSocket example

Let's look at a real-world example.

```typescript
import { SocketIoClientTransport } from '@source-repo/msgrpc'

// Create a WebSocket client
let transport = new SocketIoClientTransport('ws://localhost:3000')

transport.pipe((message) => {
    console.log('Received message: ' + message)
})

transport.receive('Sending this message over WS')
```

The SocketIoClientTransport will pass a message through the pipe each time it receives a message over the WebSocket connection. This example will open up a WebSocket connection to localhost, send a message and log each incoming message.

#### RPC over WebSocket

The power of modules is shown when you want to process messages. Here is an example of an RPC server using WebSocket.

```typescript
import { SocketIoClientTransport, Converter, RpcServerHandler, TryCatch } from '@source-repo/msgrpc'

// Create a server which listents on 0.0.0.0:3000
const server = new SocketIoClientTransport('ws://localhost:3000)

// Parse each incoming message using
const parser = new Converter([server], message => {
    return JSON.parse(message.toString()
})

// Send each parsed message to an RPC server
const rpcServerHandler = new RpcServerHandler('server', [parser])

// Serialize each outgoing message using JSON.stringify
const stringifier = new Converter([rpcServer], message => {
    return JSON.stringify(message)
})

// Try to send the message back. If we fail (probably the client disconnected), do nothing.
const tryCatch = new TryCatch([stringifier])
tryCatch.pipe(server)

// Expose a function
rpcServerHandler.manageRpc.exposeObject({
    Hello: () => {
        return 'World!'
    }
}, 'MyRpc')
```

And here is the client:

```typescript
import { SocketIoClientTransport, JsonParser, RpcClienthandler, JsonStringifier } from '@source-repo/msgrpc'

// Create a WebSocket client which connects to the server
// For use in broser, use BrowserWebSocketTransport instead
let transport = new SocketIoClientTransport('ws://localhost:3000')

// Parse each incoming message
let parser = JsonParser([transport])

// Send each parsed message to a RPC client
let rpcClientHandler = new RpcClientHandler('client', [parser])

// Serialize each outgoing message
let stringifier = JsonStringifier([rpcClient])
stringifier.pipe(transport)

// Create a JavaScript proxy object which allows us to call the RPC functions. The service name should match the exposed object on the server ("MyRpc").
let proxy = rpcClientHandler.proxy('MyRpc')

// Should output Hello World!
console.log('Hello ' + await proxy.remote.hello())
```