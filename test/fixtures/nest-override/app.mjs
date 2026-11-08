// An app that sets its own Nest logger before the bridge is imported, then
// creates its context with (argv "option") or without that logger as the
// `logger` option. It prints what its logger received.
import 'reflect-metadata';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

const received = [];
const custom = {
  log: (message) => received.push(String(message)),
  error: (message) => received.push(String(message)),
  warn: (message) => received.push(String(message)),
};
Logger.overrideLogger(custom);

const { SkeModule } = await import('../../../dist/esm/nest.js');

class AppModule {}
Module({ imports: [SkeModule.forRoot()] })(AppModule);

const app = await NestFactory.createApplicationContext(AppModule, process.argv[2] === 'option' ? { logger: custom } : {});
new Logger('Orders').log('order placed');
await app.close();
process.stdout.write(JSON.stringify(received) + '\n');
