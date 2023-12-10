class embed {
    constructor(title, description, url) {
        this.title = title;
        this.description = description;
        this.url = url;
    }

    setTitle(title) {
        this.title = title;
    }

    setDescription(description) {
        this.description = description;
    }

    setUrl(url) {
        this.url = url;
    }

    getTitle() {
        return this.title;
    }

    getDescription() {
        return this.description;
    }

    getUrl() {
        return this.url;
    }

    setAuthor(name, url, icon_url) {
        this.author = {
            name: name,
            url: url,
            icon_url: icon_url
        };
    }

    getAuthor() {
        return this.author;
    }

    setFooter(text, icon_url) {
        this.footer = {
            text: text,
            icon_url: icon_url
        };
    }

    getFooter() {
        return this.footer;
    }

    setTimestamp(timestamp) {
        this.timestamp = timestamp;
    }

    getTimestamp() {
        return this.timestamp;
    }

    setColor(color) {
        this.color = color;
    }

    getColor() {
        return this.color;
    }

    setThumbnail(url) {
        this.thumbnail = {
            url: url
        };
    }

    getThumbnail() {
        return this.thumbnail;
    }

    setImage(url) {
        this.image = {
            url: url
        };
    }

    getImage() {
        return this.image;
    }

    setFields(fields) {
        this.fields = fields;
    }

    getFields() {
        return this.fields;
    }

    addField(name, value, inline) {
        if (this.fields == undefined) {
            this.fields = [];
        }
        this.fields.push({
            name: name,
            value: value,
            inline: inline
        });
    }

    getEmbed() {
        return this;
    }    
}

module.exports = embed;