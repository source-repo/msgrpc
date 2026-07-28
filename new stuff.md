Add reflection to make it possible to have type checking enabled for debugging (or always if not performace critical):
- Use tsmorph and decorators to build a type json that can be loaded by both server and client
- include a cli in the npm package that can do the tsmorphing in the package users build process
- optionally include the type in rpc calls for runtime checking
- make a server with reflection json able to respond to a "swagger" call that returns available classes with methods and everything, events too. Also any active instances registered in the server
- make the cli able to query a server and also spin a up a web server with a rpc server scanner with "swagger" interface for found servers, including dialog to send rpc calls and see the results / events