const fs = require('fs');
const https = require('https');
const path = require('path');

const modelsDir = path.join(__dirname, 'models');
if (!fs.existsSync(modelsDir)) {
    fs.mkdirSync(modelsDir);
}

const files = [
    'tiny_face_detector_model-weights_manifest.json',
    'tiny_face_detector_model-shard1',
    'face_expression_model-weights_manifest.json',
    'face_expression_model-shard1'
];

const baseUrl = 'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights/';

console.log("Commencing secure download of Face-API neural network models...");

files.forEach(file => {
    const fileUrl = baseUrl + file;
    const dest = path.join(modelsDir, file);
    https.get(fileUrl, function(response) {
        if(response.statusCode !== 200) {
            console.error('Failed to get ' + file + ' (' + response.statusCode + ')');
            return;
        }
        const fileStream = fs.createWriteStream(dest);
        response.pipe(fileStream);
        fileStream.on('finish', function() {
            fileStream.close();
            console.log('Downloaded AI Weight successfully: ' + file);
        });
    }).on('error', function(err) {
        console.error('Error downloading ' + file + ': ' + err.message);
    });
});
