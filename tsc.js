// From: https://github.com/Microsoft/TypeScript/issues/6387

//"use strict";

var ts      = require("typescript");
var fs      = require("fs");
var path    = require("path");
var process = require("process");

function reportDiagnostics(diagnostics) { 
    diagnostics.forEach( function( diagnostic ){
        var message = "Error ";
        if (diagnostic.file) {
            var where = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
            //message += ' ' + diagnostic.file.fileName + ' ' + where.line + ', ' + where.character + 1;
            message +=  diagnostic.file.fileName + ":" + + where.line + ":" + ( where.character + 1) + ":" +
                       ts.flattenDiagnosticMessageText( diagnostic.messageText );
        }
        //message += ": " + ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
        else
        {
            message += ts.flattenDiagnosticMessageText( diagnostic.messageText );
        }
        console.log( message );
    });
    
    return ( diagnostics.length > 0 ) ? 1 : 0;
}

function readConfigFile(configFileName) { 
    // Read config file
    var configFileText = fs.readFileSync(configFileName).toString();  

    // Parse JSON, after removing comments. Just fancier JSON.parse
    var result = ts.parseConfigFileTextToJson(configFileName, configFileText);
    var configObject = result.config;
    if (!configObject) {
        reportDiagnostics([result.error]);
       
        return null;
    }

    // Extract config infromation
    var configParseResult = ts.parseJsonConfigFileContent(configObject, ts.sys, path.dirname(configFileName));
    if (configParseResult.errors.length > 0) {
        reportDiagnostics(configParseResult.errors);
       
        return null;
    }
    return configParseResult;
}


exports.compile = function compile(configFileName) {
    // Extract configuration from config file
    var config = readConfigFile(configFileName);
    if( !config )
        return 1;
        
    // Compile
    var program = ts.createProgram(config.fileNames, config.options);
    var emitResult = program.emit();

    // Report errors
    var exitCode = reportDiagnostics(ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics));
    
    // Return code
    if( exitCode == 0 )
        exitCode = emitResult.emitSkipped ? 1 : 0;
    //process.exit(exitCode);
    
    return exitCode;
}
