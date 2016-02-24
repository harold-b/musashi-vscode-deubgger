
var gulp        = require( 'gulp' );
var path        = require( 'path' );
var tsb         = require( 'gulp-tsb' );
var del         = require( 'del' );
var tsc         = require( "./tsc.js" );
var runSequence = require( 'run-sequence' );
//var compilation = tsb.create( path.join(__dirname, "src/tsconfig.json" ), false );



/// Vars
var sources = [ "src/**/*.ts" ];
var outPath = "out";


/// Methods
///*
function execLog( onFinished )
{
    var logger = function( err, stdout, stderr )
    {
        console.log( stdout );
        console.log (stderr );

        if( onFinished )
            onFinished(err);
    }

    return logger;
}

function compileTSProject()
{

    var r = tsc.compile( "./src/tsconfig.json" );
    if( r == 0 )
        console.log( "Typescript Combile Success." );
    else
        console.log( "Typescript Compilation Failed." );
    /*
    var exec = require('child_process').exec;
    exec( "tsc -p ./src", execLog( function(err){
        if( err )
            console.log( "Typescript compilation failed." );
        else
            console.log( "Typescript Success." );
    }));
    */
}


/// Tasks
gulp.task( "build", function( callback ) {
    //runSequence( "clean", "compile", callback );
    runSequence( "clean", "tsc", callback );
});

gulp.task( "clean", function() {
	return del( ['out/**'] );
});

gulp.task( "lint", function() {
   var tslint      = require( 'gulp-tslint' );
   return gulp.src( "./src/*.ts" )
            .pipe( tslint() )
            .pipe( tslint.report("verbose") ); 
});


/// Internal
gulp.task( "compile", function() {
   return gulp.src( sources, { base: '.' } )
        //.pipe( compilation() )
        .pipe( gulp.dest(outPath) );
});



/// Old Tasks
///*
gulp.task( "tsc", function() {
    compileTSProject();
});

gulp.task( "tsc_watch", function(cb) {
    gulp.watch("cl_src/*.ts", function(event) {
        //console.log('File ' + event.path + ' was ' + event.type + ', running tasks...');
        console.log("Recompiling ts files.");
        compileTSProject();
    })
    cb();
});
//*/