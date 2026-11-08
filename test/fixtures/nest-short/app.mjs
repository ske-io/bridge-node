// A short-lived Nest context with timers the platform skips: it neither
// closes the app nor asks for scheduled tasks, and exits as soon as its
// event loop is empty.
import 'reflect-metadata';
import { Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Interval, ScheduleModule, Timeout } from '@nestjs/schedule';

import { SkeModule } from '../../../dist/esm/nest.js';

class Tasks {
  poll() {}
  warmUp() {}
}
Injectable()(Tasks);
Interval('short-poll', 1000)(Tasks.prototype, 'poll', Object.getOwnPropertyDescriptor(Tasks.prototype, 'poll'));
Timeout('short-warm-up', 1000)(Tasks.prototype, 'warmUp', Object.getOwnPropertyDescriptor(Tasks.prototype, 'warmUp'));

class AppModule {}
Module({ imports: [SkeModule.forRoot(), ScheduleModule.forRoot()], providers: [Tasks] })(AppModule);

await NestFactory.createApplicationContext(AppModule, { logger: false });
