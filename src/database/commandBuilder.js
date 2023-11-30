
class CommandBuilder {
    constructor() {
        this.sql = '';
        this.params = [];
    }

    select(table, columns) {
        this.sql = `SELECT ${columns.join(', ')} FROM ${table}`;
        return this;
    }

    selectAll(table) {
        this.sql = `SELECT * FROM ${table}`;
        return this;
    }

    selectCount(table) {
        this.sql = `SELECT COUNT(*) FROM ${table}`;
        return this;
    }

    insert(table, values) {
        const columns = Object.keys(values);
        const placeholders = Object.values(values).map(() => '?');
        this.sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`;
        this.params.push(...Object.values(values));
        return this;
    }

    update(table, values) {
        const columns = Object.keys(values);
        const placeholders = Object.values(values).map(() => '?');
        this.sql = `UPDATE ${table} SET ${columns.map((column, index) => `${column} = ${placeholders[index]}`).join(', ')}`;
        this.params.push(...Object.values(values));
        return this;
    }

    delete(table) {
        this.sql = `DELETE FROM ${table}`;
        return this;
    }

    createTable(table, columns) {
        this.sql = `CREATE TABLE ${table} (${columns.join(', ')})`;
        return this;
    }

    dropTable(table) {
        this.sql = `DROP TABLE ${table}`;
        return this;
    }

    truncateTable(table) {
        this.sql = `TRUNCATE TABLE ${table}`;
        return this;
    }

    where(condition, params) {
        if (typeof condition === 'object') {
            condition = Object.keys(condition).map(column => `${column} = ?`).join(' AND ');
            params = Object.values(condition);
        }

        if(typeof params !== 'object'){
            params = [params];
        }
        
        this.sql += ` WHERE ${condition}`;
        this.params.push(...params);
        return this;
    }

    orderBy(column, direction = 'ASC') {
        this.sql += ` ORDER BY ${column} ${direction}`;
        return this;
    }

    limit(limit) {
        this.sql += ` LIMIT ${limit}`;
        return this;
    }

    build() {
        return {
            sql: this.sql,
            params: this.params
        };
    }
}

module.exports = CommandBuilder;
