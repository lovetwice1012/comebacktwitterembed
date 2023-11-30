//mysql
const mysql = require('mysql');
class databaseManager{
    constructor(){
        this.config = {
            host: '',
            user: '',
            password: '',
            database: '',
        };
    }

    setDatabaseConnectionConfig(host, user, password, database){
        this.config.host = host;
        this.config.user = user;
        this.config.password = password;
        this.config.database = database;
    }

    connect(){
        if(this.config.host === '' || this.config.user === '' || this.config.password === '' || this.config.database === ''){
            throw new Error('Database connection config not set');
        }
        this.connection = mysql.createConnection(this.config);
        this.connection.connect();
    }

    disconnect(){
        this.connection.end();
    }

    query(sql, params){
        return new Promise((resolve, reject) => {
            this.connection.query(sql, params, (error, results, fields) => {
                if(error){
                    reject(error);
                }else{
                    resolve(results);
                }
            });
        });
    }
}

module.exports = databaseManager;
