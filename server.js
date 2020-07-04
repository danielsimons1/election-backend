'use strict';

require('dotenv').config();

const express = require('express');
const app = express();
const bodyParser = require('body-parser');
const server = require('http').Server(app);
const axios = require('axios');
const xml2js = require('xml2js');
const mysql = require('promise-mysql');
const winston = require('winston');
const {LoggingWinston} = require('@google-cloud/logging-winston');
const loggingWinston = new LoggingWinston();
const logger = winston.createLogger({
  level: 'info',
  transports: [new winston.transports.Console(), loggingWinston],
});

console.dir({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  database: process.env.DB_DATABASE,
  password: process.env.DB_PASS
});

app.set('view engine', 'pug');
app.enable('trust proxy');

// Automatically parse request body as form data.
app.use(bodyParser.urlencoded({extended: false}));
app.use(bodyParser.json());

// Set Content-Type for all responses for these routes.
app.use((req, res, next) => {
  res.set('Content-Type', 'text/html');
  next();
});

app.get('/', (req, res) => {
  res.send('Hello from App Engine!');
});

const createTcpPool = async (config) => {
  // Extract host and port from socket address
  const dbSocketAddr = process.env.DB_HOST.split(":")
  logger.info({
    debug: true,
    user: process.env.DB_USER, // e.g. 'my-db-user'
    password: process.env.DB_PASS, // e.g. 'my-db-password'
    database: process.env.DB_DATABASE, // e.g. 'my-database'
    host: dbSocketAddr[0], // e.g. '127.0.0.1'
    port: dbSocketAddr[1], // e.g. '3306'
    // ... Specify additional properties here.
    ...config
  });

  // Establish a connection to the database
  return await mysql.createPool({
    debug: true,
    user: process.env.DB_USER, // e.g. 'my-db-user'
    password: process.env.DB_PASS, // e.g. 'my-db-password'
    database: process.env.DB_DATABASE, // e.g. 'my-database'
    host: dbSocketAddr[0], // e.g. '127.0.0.1'
    port: dbSocketAddr[1], // e.g. '3306'
    // ... Specify additional properties here.
    ...config
  });
}

// [START cloud_sql_mysql_mysql_create_socket]
const createUnixSocketPool = async (config) => {
  const dbSocketPath = process.env.DB_SOCKET_PATH || "/cloudsql"

  // Establish a connection to the database
  return await mysql.createPool({
    debug: true,
    user: process.env.DB_USER, // e.g. 'my-db-user'
    password: process.env.DB_PASS, // e.g. 'my-db-password'
    database: process.env.DB_DATABASE, // e.g. 'my-database'
    // If connecting via unix domain socket, specify the path
    socketPath: `${dbSocketPath}/${process.env.INSTANCE_CONNECTION_NAME}`,
    // Specify additional properties here.
    ...config
  });
}
// [END cloud_sql_mysql_mysql_create_socket]

const createPool = async () => {
  const config = {
    // [START cloud_sql_mysql_mysql_limit]
    // 'connectionLimit' is the maximum number of connections the pool is allowed
    // to keep at once.
    connectionLimit: 5,
    // [END cloud_sql_mysql_mysql_limit]

    // [START cloud_sql_mysql_mysql_timeout]
    // 'connectTimeout' is the maximum number of milliseconds before a timeout
    // occurs during the initial connection to the database.
    connectTimeout: 10000, // 10 seconds
    // 'acquireTimeout' is the maximum number of milliseconds to wait when
    // checking out a connection from the pool before a timeout error occurs.
    acquireTimeout: 10000, // 10 seconds
    // 'waitForConnections' determines the pool's action when no connections are
    // free. If true, the request will queued and a connection will be presented
    // when ready. If false, the pool will call back with an error.
    waitForConnections: true, // Default: true
    // 'queueLimit' is the maximum number of requests for connections the pool
    // will queue at once before returning an error. If 0, there is no limit.
    queueLimit: 0, // Default: 0
    // [END cloud_sql_mysql_mysql_timeout]

    // [START cloud_sql_mysql_mysql_backoff]
    // The mysql module automatically uses exponential delays between failed
    // connection attempts.
    // [END cloud_sql_mysql_mysql_backoff]
  }

  if (process.env.DB_HOST) {
    return await createTcpPool(config);
  } else {
    return await createUnixSocketPool(config);
  }
    
};
// [END cloud_sql_mysql_mysql_create]

const ensureSchema = async (pool) => {
  // Wait for tables to be created (if they don't already exist).
  await pool.query('USE election;');
  await pool.query(
    `CREATE TABLE IF NOT EXISTS election.candidate
      ( candidate_id SERIAL NOT NULL, created_at timestamp NOT NULL,
      lastname CHAR(45) NOT NULL, PRIMARY KEY (candidate_id) );`
  );
  console.log(`Ensured that table 'candidate' exists`);
};

let pool;
const poolPromise = createPool()
  .then(async (pool) => {
    console.log('we got the pool!')
    console.dir(pool);
    await ensureSchema(pool);
    return pool;
  })
  .catch((err) => {
    logger.error(err);
    console.log(err);
    process.exit(1)
  });

app.use(async (req, res, next) => {
  if (pool) {
    return next();
  }
  try {
    pool = await poolPromise;
    next();
  }
  catch (err) {
    logger.error(err);
    return next(err);
  }
});


app.get('/electiondata', (err, res) => {

	axios.get('https://www.electionbettingodds.com/President2020_api')
	  .then(response => {
		const xmlString = response.data;

		xml2js.parseString(xmlString, {attrkey: 'attributes', explicitArray: false}, (err, result) => {
    		   if(err) {
        	      throw err;
    		   }

    		   // `result` is a JavaScript object
    		   // convert it to a JSON string
    		   const json = JSON.stringify(result);

    		   // log JSON string
    		   console.log(json);
    		   
		   res.status(200);
		   res.json(result);
		   res.end();
		});
	  }).catch(error => {
        logger.error(error);
		res.status(400);
		res.json({error: 400});
	    res.end();
	  });
});

// Listen to the App Engine-specified port, or 8080 otherwise
const port = process.env.PORT || 8080;

server.listen(port, (err) => {
	if (err) {
        logger.error(err);
		throw err;
	}
	/* eslint-disable no-console */
	console.log('Node Endpoints working :)');
});
