var path    = require( "path"     );
var Promise = require( "bluebird" )
var fs      = require( "fs-extra" );

fs = Promise.promisifyAll( fs );

var package     = fs.readJsonSync( "./package.json" );
var extNameFull = package.name + "@" + package.version;
var outPath     = path.normalize(path.join( "./builds", extNameFull ));

var copyFiles   = [
    "out",
    "package.json",
    "readme.md"
];

var shouldCopyFile = function(f) {
    var len = copyFiles.length;
    f = f.toLowerCase();
    for( var i=0; i < len; i++ )
        if( f === copyFiles[i] )
            return true;

    return false;
}

// Prepare directories
fs.mkdirpSync( outPath );
fs.emptyDirSync( outPath );

// Get root level, only copy those which are 
var files = fs.readdirSync(".");

// Copy files
var copies = [];
files.forEach( function(f) {

    if( !shouldCopyFile(f) )
        return;
    
    //console.log(f);
    copies.push( fs.copy( f, path.join(outPath,f) ) );
});

Promise.all( copies )
.then( function(){
    console.log( "Finished making extension." );
})
.catch( function( err ) {
    console.error( "Failed to copy files with error:" + err );
});