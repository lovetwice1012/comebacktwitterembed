const express = require('express');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const app = express();
const port = 3088;
const tempDir = path.join(__dirname, 'temp');

const path = require('path');
const fs = require('fs');

function antiDirectoryTraversalAttack(userInput) {
    const baseDirectory = path.resolve('saves');
    if (userInput.includes('\0')) {
        throw new Error('不正なパスが検出されました。');
    }
    const invalidPathPattern = /(\.\.(\/|\\|$))/;
    if (invalidPathPattern.test(userInput)) {
        throw new Error('不正なパスが検出されました。');
    }
    const joinedPath = path.join(baseDirectory, userInput);
    let realPath;
    try {
        realPath = fs.realpathSync(joinedPath);
    } catch (err) {
        throw new Error('不正なパスが検出されました。');
    }
    const relativePath = path.relative(baseDirectory, realPath);
    if (
        relativePath.startsWith('..') ||
        path.isAbsolute(relativePath) ||
        relativePath.includes('\0') ||
        !realPath.startsWith(baseDirectory)
    ) {
        throw new Error('不正なパスが検出されました。');
    }
    return realPath;
}


// 一時的なディレクトリが存在しない場合は作成
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
}

app.get('/data/:userid/:tweetID/:filename', (req, res) => {
    const { userid, tweetID, filename } = req.params;
    let  filePath = path.join(userid, tweetID, filename);

    try{
        filePath = antiDirectoryTraversalAttack(filePath)
    }catch (e){
        return res.status(418).send('File not found');
    }

    fs.access(filePath, fs.constants.F_OK, (err) => {
        if (err) {
            // ファイルが存在しない場合
            res.status(418).send('File not found');
        } else {
            // ファイルが存在する場合
            res.sendFile(filePath);
        }
    });
});

app.get('/download/:userid/:tweetID', (req, res) => {
    const { userid, tweetID } = req.params;
    let  filePath = path.join(userid, tweetID);

    try{
        filePath = antiDirectoryTraversalAttack(filePath)
    }catch (e){
        return res.status(418).send('File not found');
    }
    
    fs.readdir(dirPath, (err, files) => {
        if (err) {
            res.status(500).send('Internal Server Error');
            return;
        }

        if (files.length === 0) {
            res.status(418).send('No files to download');
            return;
        }

        const zipName = `${userid}_${tweetID}_files.zip`;
        let zipPath = path.join(tempDir, zipName);

        try{
            zipPath = antiDirectoryTraversalAttack(zipPath)
        }catch (e){
            return res.status(418).send('File not found');
        }

        const archive = archiver('zip', { zlib: { level: 9 } });

        archive.on('error', (archiveError) => {
            res.status(500).send('Error creating zip file');
            return;
        });

        res.attachment(zipName);
        archive.pipe(res);

        files.forEach((file) => {
            const filePath = path.join(dirPath, file);
            archive.file(filePath, { name: file });
        });

        archive.finalize();
    });
});

app.get('/download/:userid', (req, res) => {
    const { userid } = req.params;
    try{
        dirPath = antiDirectoryTraversalAttack(userid)
    }catch (e){
        return res.status(418).send('File not found');
    }

    fs.readdir(dirPath, (err, files) => {
        if (err) {
            res.status(500).send('Internal Server Error');
            return;
        }

        if (files.length === 0) {
            res.status(418).send('No files to download');
            return;
        }

        const zipName = `${userid}_files.zip`;
        const zipPath = path.join(tempDir, zipName);

        const archive = archiver('zip', { zlib: { level: 9 } });

        archive.on('error', (archiveError) => {
            res.status(500).send('Error creating zip file');
            return;
        });

        res.attachment(zipName);
        archive.pipe(res);

        files.forEach((file) => {
            // ディレクトリの場合は再帰的にファイルを追加
            if (fs.statSync(path.join(dirPath, file)).isDirectory()) {
                const dirPath2 = path.join(dirPath, file);
                const files2 = fs.readdirSync(dirPath2);

                files2.forEach((file2) => {
                    const filePath = path.join(dirPath2, file2);
                    archive.file(filePath, { name: `${file}/${file2}` });
                });

                return;
            }
            const filePath = path.join(dirPath, file);
            archive.file(filePath, { name: file });
        });

        archive.finalize();
    });
});

app.use((req, res) => {
    // 404 Not Found
    res.status(404).send('Not Found');
});

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
