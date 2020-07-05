'use strict';

require('dotenv').config();

const Promise = require('bluebird')
const express = require('express');
const app = express();
const bodyParser = require('body-parser');
const server = require('http').Server(app);
const axios = require('axios');
const xml2js = require('xml2js');
const mysql = require('promise-mysql');
const winston = require('winston');
const {
  LoggingWinston
} = require('@google-cloud/logging-winston');
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
app.use(bodyParser.urlencoded({
  extended: false
}));
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
  /// If the tables do not exist we create them on server startup
  /// This is not a great long-term strategy
  return await pool.query(
    `CREATE TABLE IF NOT EXISTS election.candidate
      ( candidate_id INT NOT NULL AUTO_INCREMENT,
        created_at timestamp NOT NULL,
        firstname CHAR(45),
        lastname CHAR(45),
        gender CHAR(1),
        age INT,
        win_probability DOUBLE,
        PRIMARY KEY (candidate_id) );`
  );
  console.log(`Ensured that table 'candidate' exists`);
};

let pool;
const poolPromise = createPool()
  .then(async (pool) => {
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
  } catch (err) {
    logger.error(err);
    return next(err);
  }
});


app.get('/electiondata', (err, res) => {

  axios.get('https://www.electionbettingodds.com/President2020_api')
    .then((response) => {

      const xmlString = response.data;

      return xml2js.parseStringPromise(xmlString, {
        attrkey: 'attributes',
        explicitArray: false
      });
    }).then(async (result) => {

      console.dir(result);

      if (result && result.BettingData) {
        console.log("Found data.......")

        const data = formatBettingData(result);

        const queryResults = await pool.query(`SELECT * from election.candidate;`);

        res.status(200);
        res.json({
          data,
          queryResults
        });
        res.end();
      } else {
        res.status(400);
        res.json({
          error: 400,
          description: "Invalid response data: missing result key"
        });
        res.end();
      }
    }).catch(error => {
      console.dir(error);
      //logger.error(error);
      res.status(400);
      res.json({
        error: 400
      });
      res.end();
    });
});

const formatBettingData = (data) => {
  console.log("formatting betting data...");
  if (data.BettingData["attributes"]) {
    delete data.BettingData["attributes"];
    delete data.BettingData["Time"];
  }

  return data;
};

app.get('/store-election-data', (err, res) => {

  axios.get('https://www.electionbettingodds.com/President2020_api')
    .then((response) => {

      const xmlString = response.data;

      return xml2js.parseStringPromise(xmlString, {
        attrkey: 'attributes',
        explicitArray: false
      })
    }).then(async (result) => {
      if (!result || !result.BettingData) {
        logger.error('Invalid response data: missing result key');
        throw new Error("Invalid response data: missing result key");
      }

      const data = formatBettingData(result);
      const candidateData = data.BettingData;

      const bettingDataKeys = Object.keys(candidateData);

      const queryResults = await pool.query(`SELECT * from election.candidate;`);

      return Promise.map(bettingDataKeys, async (key) => {
        let foundRow = queryResults.find(queryResult => {
          console.log(queryResult);
          queryResult.lastName == key;
        });

        if (foundRow) {
          let updateQueryString = `UPDATE election.candidate set (win_probability = ${parseFloat(candidateData[key])}) where lastname = '${key}'`;
          return await pool.query(updateQueryString);
        } else {
          console.log(key + ' ' + candidateData[key]);

          let insertQueryString = `INSERT INTO election.candidate (created_at, lastname, win_probability) VALUES (now(), '${key}', '${parseFloat(candidateData[key])}')`;
          return await pool.query(insertQueryString);
        }
      });

    }).then(result => {
      res.status(200);
      res.json({
        success: 200
      })
      res.end();
    }).catch(error => {
      logger.error(error);
      res.status(400);
      res.json({
        error: 400
      });
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
  console.log('Node Endpoints working :) Yay!!!!');
});