// A NestJS app compiled to CommonJS: it loads the package's CommonJS build,
// while `ske-bridge schedule` runs from the ES modules build.
require('reflect-metadata');
const { Injectable, Module } = require('@nestjs/common');
const { Cron, ScheduleModule } = require('@nestjs/schedule');
const { SkeModule } = require('../../../dist/cjs/nest.js');

class Tasks {
  tick() {
    process.stdout.write('commonjs-cron ran\n');
  }
}
Injectable()(Tasks);
Cron('* * * * *', { name: 'commonjs-cron' })(Tasks.prototype, 'tick', Object.getOwnPropertyDescriptor(Tasks.prototype, 'tick'));

class AppModule {}
Module({ imports: [SkeModule.forRoot(), ScheduleModule.forRoot()], providers: [Tasks] })(AppModule);

module.exports = { AppModule };
