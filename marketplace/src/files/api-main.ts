import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { configureApp } from '../configure-app.js';
const app=await NestFactory.create(AppModule,{bodyParser:false,logger:false});
configureApp(app);
await app.listen(0,'127.0.0.1');
process.send?.({base:await app.getUrl()});
