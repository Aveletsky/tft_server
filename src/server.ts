import * as Koa from 'koa';
import * as bodyParser from 'koa-bodyparser';
import * as chalk from 'chalk';
import * as logger from 'koa-logger';
import * as compress from 'koa-compress';
import * as conditional from 'koa-conditional-get';
import * as etag from 'koa-etag';
import { Tasks } from './tasks';
import routes from './api';
import err from './middleware/error';

const config = require('config');
const env = process.env.NODE_ENV || 'dev';
const port = process.env.PORT || config.get('port');

const tasks = new Tasks().runTasks();

const app = new Koa();

app.use(etag());
app.use(err);

if (env === 'dev') {
    app.use(logger());
}

app.use(routes);


const server = app.listen(port, () => {
    if (env === 'localDev') {
        console.log(chalk.black.bgGreen.bold(`Listening on port: ${port}; db: ${config.get('db')}; env: ${env}`));
        console.log(chalk.red.bold('А ты помнишь про TDD? Написал(а) тесты?'));
    } else {
        console.log(chalk.red.bold(`Сервер TFT запущен на ${port}; env: ${env}`));
    };
});

const appServer = {
    server
};

export default appServer;
