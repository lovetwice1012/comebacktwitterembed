
class ColumnBuilder {
    constructor(name) {
        this.column = "";
        this.name = name;
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
        return `${this.name} ${this.column}`;
    }

}

module.exports = ColumnBuilder;
