
class ColumnBuilder {
    constructor() {
        this.column = "";
        this.name = "";
    }

    setColumnName(name) {
        this.name = name;
        return this;
    }

    integer() {
        this.column += 'INTEGER';
        return this;
    }

    text() {
        this.column += 'TEXT';
        return this;
    }

    varchar(length) {
        this.column += `VARCHAR(${length})`;
        return this;
    }

    notNull() {
        this.column += ' NOT NULL';
        return this;
    }

    autoIncrement() {
        this.column += ' AUTO_INCREMENT';
        return this;
    }

    build() {
        if(this.name === '') throw new Error('Column name not set');
        if(this.column === '') throw new Error('Column option not set');
        return `${this.name} ${this.column}`;
    }

}

module.exports = ColumnBuilder;
