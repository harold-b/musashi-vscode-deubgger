
import {
    DebugSession, Thread, Source, StackFrame, Scope, Variable, Breakpoint,
    TerminatedEvent, InitializedEvent, StoppedEvent, OutputEvent,
    Handles, ErrorDestination
} from 'vscode-debugadapter';

import {
    DebugProtocol
} from 'vscode-debugprotocol';

import * as Net  from 'net';
import * as Path from 'path';
import * as FS   from 'fs';
import * as util from 'util';
import * as assert from 'assert';
import { ISourceMaps, SourceMaps, Bias } from './sourceMaps';
import * as PathUtils from './pathUtilities';

import {
    DukDbgProtocol,
    DukEvent,
    DukStatusState,
    
    /// Notifications
    DukStatusNotification,
    DukPrintNotification,
    DukAlertNotification,
    DukLogNotification,
    DukThrowNotification,
    
    // Responses
    DukListBreakResponse,
    DukAddBreakResponse,
    DukGetCallStackResponse,
    DukCallStackEntry,
    DukGetLocalsResponse,
    DukEvalResponse,
    DukGetHeapObjInfoResponse,
    DukGetClosureResponse
   
} from "./DukDbgProtocol";

import * as Duk from "./DukConsts";


/**
 * Arguments shared between Launch and Attach requests.
 */
export interface CommonArguments {
    /** comma separated list of trace selectors. Supported:
     * 'all': all
     * 'la': launch/attach
     * 'bp': breakpoints
     * 'sm': source maps
     * */
    trace?: string;
    /** Automatically stop target after launch. If not specified, target does not stop. */
    stopOnEntry?: boolean;
    /** Configure source maps. By default source maps are disabled. */
    sourceMaps?: boolean;
    /** Where to look for the generated code. Only used if sourceMaps is true. */
    outDir?: string;
}

/**
 * This interface should always match the schema found in the node-debug extension manifest.
 */
export interface LaunchRequestArguments extends CommonArguments {
    /** An absolute path to the program to debug. */
    program: string;
    /** Optional arguments passed to the debuggee. */
    args?: string[];
    /** Launch the debuggee in this working directory (specified as an absolute path). If omitted the debuggee is lauched in its own directory. */
    cwd?: string;
    /** Absolute path to the runtime executable to be used. Default is the runtime executable on the PATH. */
    runtimeExecutable?: string;
    /** Optional arguments passed to the runtime executable. */
    runtimeArgs?: string[];
    /** Optional environment variables to pass to the debuggee. The string valued properties of the 'environmentVariables' are used as key/value pairs. */
    env?: { [key: string]: string; };
    /** If true launch the target in an external console. */
    externalConsole?: boolean;
}

/**
 * This interface should always match the schema found in the node-debug extension manifest.
 */
export interface AttachRequestArguments extends CommonArguments {
    /** The debug port to attach to. */
    port: number;
    /** The TCP/IP address of the port (remote addresses only supported for node >= 5.0). */
    address?: string;
    /** Retry for this number of milliseconds to connect to the node runtime. */
    timeout?: number;

    /** Node's root directory. */
    remoteRoot?: string;
    /** VS Code's root directory. */
    localRoot?: string;
}

// Utitity
class ArrayX
{
    public static firstOrNull<T>( target:Array<T>, comparer:( value:T ) => boolean ) : T
    {
        for( let i=0; i < target.length; i++ )
            if( comparer( target[i] ) )
                return target[i];
                
        return null;
    }
    
    public static convert<T,U>( target:Array<T>, converter:( value:T ) => U ) : Array<U>
    {
        let result = new Array<U>( target.length );
        for( let i=0; i < target.length; i++ )
            result[i] = converter( target[i] );
            
        return result;
    }
}


enum LaunchType
{
    Launch = 0,
    Attach
}


class DukBreakPoint
{
    public dukIdx:number;   // duktape breakpoint index
    public line  :number;   // Front-end line number
    
    constructor( index:number, line:number )
    {
        this.dukIdx = index;
        this.line   = line;
    }
}

class SourceFile
{
    public id         :number;
    public name       :string;
    public path       :string;
    
    public srcMapPath :string;
    //public srcMap     :SourceMap;
    
    public breakpoints:DukBreakPoint[];
    
    constructor()
    {
        this.breakpoints = new Array<DukBreakPoint>();
    }
}

class DukVar
{
    public name       :string;
    public value      :string;
    public type       :string;
    
    constructor( name:string, value:string )
    {
        this.name       = name;
        this.value      = value;
    }
}

type PropertyInfo = { n:string, t:string, v:any };
 
enum PropertySetType
{
    Scope  = 0,
    Object,
    Internal
}

class PropertySet
{
    public handle    :number;
    public prefix    :string;
    public ctorName  :string;   // TODO: Remove prefix, not using it anymore

    public heapPtr   :Duk.TValPointer;
    public scope     :DukScope;
    public type      :PropertySetType;
    public keys      :string[];
    public variables :Variable[];
    
    public constructor( prefix:string, type:PropertySetType )
    {
        this.prefix = prefix;
        this.type   = type;
    }
}

class DukScope
{
    public handle     :number;
    public name       :string;
    public stackFrame :DukStackFrame;
    public properties :PropertySet;
    
    public constructor( name:string, stackFrame:DukStackFrame, properties:PropertySet )
    {
        this.name       = name;
        this.stackFrame = stackFrame;
        this.properties = properties;
    }
}

class DukStackFrame
{
    public handle     :number;
    public source     :SourceFile;
    public fileName   :string;
    public funcName   :string;
    public lineNumber :number;
    public pc         :number;
    public depth      :number;
    public klass      :string;
    public scopes     :DukScope[];

    public constructor( source:SourceFile, fileName:string, funcName:string,
                        lineNumber:number, pc:number, depth:number,
                        scopes:DukScope[] )
    {
        this.source     = source     ;
        this.fileName   = fileName   ;
        this.funcName   = funcName   ;
        this.lineNumber = lineNumber ;
        this.pc         = pc         ;
        this.depth      = depth      ;
        this.scopes     = scopes     ;
    }
}

class PtrPropDict {  [key:string]:PropertySet };

class DbgClientState
{
    public paused        :boolean;
    public expectingBreak:string;
    
    public ptrHandles   :PtrPropDict;            // Access to property sets via pointers
    public varHandles   :Handles<PropertySet>;   // Handles to property sets
    public stackFrames  :Handles<DukStackFrame>;
    public scopes       :Handles<DukScope>;
    public nextSrcID    :number;
    
    
    public reset() : void
    {
        this.paused         = false;
        this.expectingBreak = undefined;
        this.ptrHandles     = new PtrPropDict();
        this.varHandles     = new Handles<PropertySet>();
        this.stackFrames    = new Handles<DukStackFrame>();
        this.scopes         = new Handles<DukScope>();
        this.nextSrcID      = 1;
    }
}

class ErrorCode
{
    public static RequestFailed = 100;
}

class DukDebugSession extends DebugSession
{
    private static THREAD_ID = 1;
    
       
    private _launchArgs:LaunchRequestArguments;
    private _attachArgs:AttachRequestArguments;
    
    private _args           :CommonArguments;
    private _sources        :{};
    private _sourceMaps     :SourceMaps;
    private _launchType     :LaunchType;
    private _targetProgram  :string;
    private _sourceRoot     :string;
    private _remoteRoot     :string;
    private _outDir         :string;
    private _stopOnEntry    :boolean;
    private _dukProto       :DukDbgProtocol;
    
    private _dbgState       :DbgClientState;
    private _initResponse   :DebugProtocol.Response;
    
    private _awaitingInitialStatus:boolean;
    private _initialStatus  :DukStatusNotification;
    
  
    //-----------------------------------------------------------
    public constructor()
    {
        super();
        this.logToClient( "DukDebugSession()" );

        // this debugger uses zero-based lines and columns
        this.setDebuggerLinesStartAt1   ( true );
        this.setDebuggerColumnsStartAt1 ( true );
        
        this._dbgState = new DbgClientState();
        
        this.initDukDbgProtocol();
    }
    
    //-----------------------------------------------------------
    private initDukDbgProtocol() : void
    {
        this._dukProto = new DukDbgProtocol( ( msg ) => this.logToClient(msg) ); 
        
        // Status
        this._dukProto.on( DukEvent[DukEvent.nfy_status], ( status:DukStatusNotification ) => {
            
            this.logToClient( "Status Notification: " + 
                (status.state == DukStatusState.Paused ? "pause" : "running") );
            
            let stopReason = this._dbgState.expectingBreak == undefined ?
                 "debugger" : this._dbgState.expectingBreak;
           
            this._dbgState.expectingBreak = undefined;
            
            if( !this._initialStatus )
            {
                if( this._awaitingInitialStatus )
                {
                    this._initialStatus = status;
                    this._awaitingInitialStatus = false;
                    
                }
                
                // Don't act on any stop commands until it responds to the status we asked for
                return;
            }
            
            // Pause/Unpause
            if( status.state == DukStatusState.Paused )
            {
                //this.logToClient( "Pause reported" );
                this._dbgState.reset();
                this._dbgState.paused = true;
                this.sendEvent( new StoppedEvent( stopReason, DukDebugSession.THREAD_ID ) );
            }
            else
            {
                // Resume
                //this._dbgState.reset();
                this._dbgState.paused = false;
                // TODO: Resume?
            }
        });
         
        // Disconnect
        this._dukProto.once( DukEvent[DukEvent.disconnected], ( reason:string) => {
            this.logToClient( `Disconnected: ${reason}` ); 
            this.sendEvent( new TerminatedEvent() );
        });
        
        // Output
        this._dukProto.on( DukEvent[DukEvent.nfy_print], ( e:DukPrintNotification ) => {
            this.logToClient( e.message );
        });
        
        this._dukProto.on( DukEvent[DukEvent.nfy_alert], ( e:DukAlertNotification ) => {
            this.logToClient( e.message );
        });
        
        this._dukProto.on( DukEvent[DukEvent.nfy_log], ( e:DukLogNotification ) => {
            this.logToClient( e.message );
        });
        
        // Throw
        this._dukProto.on( DukEvent[DukEvent.nfy_throw], ( e:DukThrowNotification ) => {
            this.logToClient( `Exception thrown @ ${e.fileName}:${e.lineNumber} : ${e.message}` );
        });
    }

    //-----------------------------------------------------------
    // Begin initialization. Attempt to connect to target
    //----------------------------------------------------------- 
    private beginInit( response:DebugProtocol.Response ) : void
    {
        this._initialStatus         = null;
        this._awaitingInitialStatus = false;
        
        // Attached to Debug Server
        this._dukProto.once( DukEvent[DukEvent.attached], ( success:boolean ) => {
            
            if( success )
            {
                this.logToClient( "Attached to duktape debugger." );
                this.finalizeInit( response );
            }
            else
            {
                this.logToClient( "Attach failed." );
                this.sendErrorResponse( response, 0, "Attach failed" ); 
            }
        });
        
        this._dukProto.attach( "127.0.0.1", 9091 );
    }
    
    //-----------------------------------------------------------
    // Finalize initialization, sned initialized event
    //-----------------------------------------------------------
    private finalizeInit( response:DebugProtocol.Response ) : void
    {
        this.logToClient( "Finalized Initialization." );
        
        this._sources = {};
        
        if( this._args.sourceMaps )
            this._sourceMaps = new SourceMaps( this._outDir );
        
        this._dbgState.reset();
        this._initResponse          = null;
        
        // Make sure that any breakpoints that were left set in 
        // case of a broken connection are cleared
        this.removeAllTargetBreakpoints().catch()
        .then( () =>{
                
            this._awaitingInitialStatus = true;
            
            // Set initial paused state
            if( this._args.stopOnEntry )
                this._dukProto.requestPause();
            else
                this._dukProto.requestResume();
        }).catch();
        
        // Let the front end know we're done initializing
        this.sendResponse( response );
        this.sendEvent( new InitializedEvent() );
    }
    
    /// DebugSession
    //-----------------------------------------------------------
    // The 'initialize' request is the first request called by the frontend
    // to interrogate the features the debug adapter provides.
    //-----------------------------------------------------------
    protected initializeRequest( response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments ): void
    {
        this.logToClient( "initializeRequest." );
        
        // This debug adapter implements the configurationDoneRequest.
        response.body.supportsConfigurationDoneRequest = true;
        response.body.supportsFunctionBreakpoints      = false;
        response.body.supportsEvaluateForHovers        = true;
        
        this.sendResponse( response );
    }
    
    //-----------------------------------------------------------
    protected launchRequest( response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments ) : void
    {
        this.logToClient( "launchRequest" );
        return;
        
        this.logToClient( "Program : " + args.program );
        this.logToClient( "CWD     : " + args.cwd );
        this.logToClient( "Stop On Entry  : " + args.stopOnEntry );
        
        
        this._launchType    = LaunchType.Launch;
        this._targetProgram = args.program;
        this._sourceRoot    = this.normPath( args.cwd );
        this._stopOnEntry   = args.stopOnEntry;
        
        /// TODO: Support launch
        
        //this.init();

        if( args.stopOnEntry ) 
        {
            this.sendResponse( response );

            // we stop on the first line
            //this.sendEvent( new StoppedEvent( "entry", DukDebugSession.THREAD_ID ) );
        } 
        else
        {
            // we just start to run until we hit a breakpoint or an exception
            this.continueRequest( response, { threadId: DukDebugSession.THREAD_ID } );
        }
    }
    
    //-----------------------------------------------------------
    protected attachRequest( response: DebugProtocol.AttachResponse, args: AttachRequestArguments ) : void
    {
        this.logToClient( "attachRequest" );
        
        this._args          = args;
        this._launchType    = LaunchType.Attach;
        this._sourceRoot    = this.normPath( args.localRoot );
        this._remoteRoot    = this.normPath( args.remoteRoot );
        this._outDir        = this.normPath( args.outDir );
        
        this.beginInit( response );
    }
    
    //-----------------------------------------------------------
    protected disconnectRequest( response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments ) : void
    {
        this.logToClient( "disconnectRequest" );
        
        const timeoutMS = 2000;
        
        var finished:boolean = false;
        
         var doDisconnect = () => {
            
            if( finished )
                return;
                
            finished = true;
            
            this.logToClient( "Disconnecing Socket." );
            this._dukProto.disconnect();
            this.sendResponse( response );
        };
        
        var timeoutID:NodeJS.Timer = setTimeout( () =>{
            
            clearTimeout( timeoutID );
            if( finished )
                return;
                
            this.logToClient( "Detach request took too long. Forcefully disconnecting." );
            doDisconnect();
            
        }, timeoutMS );
        
        
        // Detach request after clearing all the breakpoints
        var doDetach = () => {
            
            if( finished )
                return;
                
            this._dukProto.requestDetach().then().catch( e=>{} )
                .then( () => {
                    doDisconnect();
                });
        };
        
        
        // Clear all breakpoints
        var sources:SourceFile[] = [];
        for( let k in this._sources )
        {
            let src:SourceFile = this._sources[k];
            if( src.breakpoints && src.breakpoints.length > 0 )
                sources.push( src );
        }
        
        var clearSource = ( i:number ) => {
            
            if( i >= sources.length )
            {
                // finished
                doDetach();
                return;
            }  
            
            this.clearBreakPoints( sources[i] )
                .then().catch( err =>{}).then( () =>{
                    clearSource( i+1 );    
                });
        };
        
        if( sources.length > 0 )
        {
            this.logToClient( "Clearing breakpoints on target." );
            clearSource(0);
        }
        else
        {
            this.logToClient( "No breakpoints. Detaching immediately." );
            doDetach();
        }
    }
    
    //-----------------------------------------------------------
    protected setBreakPointsRequest( response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments ) : void
    {
        this.logToClient( "setBreakPointsRequest" );
        
        // Try to find the source file
        var src:SourceFile = this.mapSourceFile( this.getSourceNameByPath( args.source.path ) );
        
        if( !src )
        {
            this.logToClient( "Unknown source file: " + args.source.path );
            this.sendErrorResponse( response, 0, "SetBreakPoint failed" ); 
            return;
        }
        
        var inBreaks  = args.breakpoints;        // Should be an array of "SourceBreakpoint"s
        var outBreaks = new Array<Breakpoint>();

        var doRequest = ( i:number ) =>
        {
            if( i >= inBreaks.length )
            {
                response.body = { breakpoints: outBreaks };
                this.sendResponse( response );
                return;
            }
            
            var bp   = inBreaks[i];
            let line = this.convertDebuggerLineToClient( bp.line );
            let name = this.normPath( src.name );
            
            // Check if it has a source map
            if( src.srcMapPath )
            {
                try{
                    let result  = this._sourceMaps.MapFromSource( src.path, bp.line, 0, Bias.LEAST_UPPER_BOUND );
                    line = result.line;                    
                }
                catch( err ) {}
            }
            
            this._dukProto.requestSetBreakpoint( name, line )
                .then( resp => {
                
                /// Save the breakpoints to the file source
                let r = <DukAddBreakResponse>resp;
                
                src.breakpoints.push( new DukBreakPoint( r.index, bp.line ) );
                //this.logToClient( "BRK: " + r.index + " ( " + bp.line + ")");
                
                outBreaks.push( new Breakpoint( true, bp.line ) );
                
            }).catch( err => {
                // Simply don't add the breakpoint if it failed.
            }).then(() => {
                
                // Go to the next one
                doRequest( i+1 );
            });
            
        };
        
        // TODO: Only delete breakpoints that have been removed, not all the cached breakpoints.
        this.clearBreakPoints( src ).then().catch( e => {} ).then( () => {
            doRequest(0);
        });
    }
    
    //-----------------------------------------------------------
    protected setFunctionBreakPointsRequest( response: DebugProtocol.SetFunctionBreakpointsResponse, args: DebugProtocol.SetFunctionBreakpointsArguments ): void
    {
        this.logToClient( "setFunctionBreakPointsRequest" );
        this.sendResponse( response );
    }
    
    //-----------------------------------------------------------
    protected setExceptionBreakPointsRequest( response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments ): void
    {
        this.logToClient( "setExceptionBreakPointsRequest" );
        this.sendResponse( response );
    }
    
    //-----------------------------------------------------------
    protected configurationDoneRequest( response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments ): void
    {
        this.logToClient( "configurationDoneRequest" );
        this.sendResponse( response );
    }
    
    //-----------------------------------------------------------
    protected continueRequest( response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments ): void
    {
        this.logToClient( "continueRequest" );
        
        if( this._dbgState.paused )
        {
            this._dukProto.requestResume().then( ( val ) => {
                
                // A status notification should follow shortly
                this.sendResponse( response );
                
            }).catch( (err) => {
                
                this.requestFailedResponse( response );
            });
        }
        else
        {
            this.logToClient( "Can't continue when not paused" );
            this.requestFailedResponse( response, "Not paused." );
            return;
        }
    }
    
    //-----------------------------------------------------------
    // StepOver
    protected nextRequest( response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments ): void
    {
        this.logToClient( "nextRequest" );
        
        if( !this._dbgState.paused )
        {
            this.logToClient( "Can't step over when not paused" );
            this.requestFailedResponse( response, "Not paused." );
            return;
        }
        
        this._dukProto.requestStepOver().then( ( val ) => {
            // A status notification should follow shortly
            this.sendResponse( response );
            
        }).catch( (err) => {
            this.requestFailedResponse( response );
        });
    }
    
    //-----------------------------------------------------------
    // StepInto
    protected stepInRequest (response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments ): void
    {
        this.logToClient( "stepInRequest" );
        
        if( !this._dbgState.paused )
        {
            this.logToClient( "Can't step into when not paused" );
            this.requestFailedResponse( response, "Not paused." );
            return;
        }
        
        this._dukProto.requestStepInto().then( ( val ) => {
            // A status notification should follow shortly
            this.sendResponse( response );
            
        }).catch( (err) => {
            this.requestFailedResponse( response );
        });
    }
    
    //-----------------------------------------------------------
    // StepOut
    protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void
    {
        this.logToClient( "stepOutRequest" );
        
        if( !this._dbgState.paused )
        {
            this.logToClient( "Can't step out when not paused" );
            this.requestFailedResponse( response, "Not paused." );
            return;
        }
        
        this._dukProto.requestStepOut().then( ( val ) => {
            // A status notification should follow shortly
            this.sendResponse( response );
            
        }).catch( (err) => {
            this.requestFailedResponse( response );
        });
    }
    
    //-----------------------------------------------------------
    protected pauseRequest( response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments ): void
    {
        this.logToClient( "pauseRequest" );
        
        if( !this._dbgState.paused )
        {
            this._dbgState.expectingBreak = "user request";
            
            this._dukProto.requestPause().then( ( val ) => {
                
                // A status notification should follow shortly
                this.sendResponse( response );
                
            }).catch( (err) => {

                this.requestFailedResponse( response, "Error pausing." );
            });
        }
        else
        {
            this.logToClient( "Can't paused when already paused." );
            this.requestFailedResponse( response, "Already paused." );
        }
    }
    
    //-----------------------------------------------------------
    protected sourceRequest( response: DebugProtocol.SourceResponse, args: DebugProtocol.SourceArguments ): void
    {
        this.logToClient( "sourceRequest" );
        
        let ref = args.sourceReference;
        
        response.body = { content: "Unknown Source\n" };
        
        this.sendResponse( response );
    }
    
    //-----------------------------------------------------------
    protected threadsRequest( response: DebugProtocol.ThreadsResponse ): void
    {
        this.logToClient( "threadsRequest" );
        
        response.body = {
            threads:  [ new Thread( DukDebugSession.THREAD_ID, "Main Thread") ]
        };
            
        this.sendResponse( response );
    }
    
    //-----------------------------------------------------------
    protected stackTraceRequest( response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments ): void
    {
        this.logToClient( "[FE] stackTraceRequest" );
        
        // Make sure we're paused
        if( !this._dbgState.paused )
        {
            this.requestFailedResponse( response, 
                "Attempted to get stack trace while in running." );
            return;
        }
        
        var getCallStack;
        var dukframes  = new Array<DukStackFrame>();
        
        var doRespond = () => {
            
            // Publish Stack Frames
            let frames = [];
            frames.length = dukframes.length;
            
            for( let i = 0, len=frames.length; i < len; i++ )
            {
                let frame = dukframes[i];
                
                // Find source file
                let srcFile = frame.source;
                let src     = null;
                if( srcFile )
                    src = new Source( srcFile.name, srcFile.path, srcFile.id );
                
                let klsName  = frame.klass == "" ? "" : frame.klass + ".";
                let funcName = frame.funcName == "" ? "(anonymous function)" : frame.funcName + "()";
                
                //i: number, nm: string, src: Source, ln: number, col: number
                frames[i] = new StackFrame( frame.handle,
                                 klsName + funcName + " : " + frame.pc,
                                 src, frame.lineNumber, frame.pc );
            }
            
            response.body = { stackFrames: frames };
            this.sendResponse( response );
        };
        
        var doApplyConstructors = ( index:number ) => {
          
            if( index >= dukframes.length )
            {
                // Finalize response
                doRespond();
                return;
            }
          
            this.getObjectConstructorByName( "this", dukframes[index].depth )
            .then( ( c:string ) => {
                dukframes[index].klass = c;
                doApplyConstructors( index+1 );
            });
          
        };
        
        // Grab callstack from duktape
        this._dukProto.requestCallStack().then( ( val:DukGetCallStackResponse ) => {
           
            dukframes.length = val.callStack.length;
            
            for( let i = 0, len=dukframes.length; i < len; i++ )
            {
                let entry = val.callStack[i];
                
                let srcFile:SourceFile = this.mapSourceFile( entry.fileName   );
                let line = this.convertDebuggerLineToClient( entry.lineNumber );
                
                // Check if it has a source map
                if( srcFile && srcFile.srcMapPath )
                {
                    try {
                        let result  = this._sourceMaps.MapToSource( srcFile.srcMapPath, line, 0, Bias.LEAST_UPPER_BOUND );
                        
                        if( result)
                            line = result.line;
                    }
                    catch( err ) {}
                }
                               
                // Save stack frame with local vars
                let frame = new DukStackFrame( srcFile, entry.fileName, entry.funcName, 
                                               line, entry.pc, -i-1, null );
                
                frame.handle = this._dbgState.stackFrames.create( frame );
                dukframes[i] = frame;
            }
            
            // Apply constructors to functions
            doApplyConstructors( 0 );
        
        }).catch( ( err ) => {
            this.logToClient( "Stack trace failed: " + err );
            
            response.body = { stackFrames: [] };
            this.sendResponse( response );
            //this.requestFailedResponse( response, "StackTraceRequest failed." );
        });
        
        
    }
    
    //-----------------------------------------------------------
    protected scopesRequest( response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments ): void
    {
        this.logToClient( "[FE] scopesRequest" );
        assert( this._dbgState.paused );
        
        const stackFrameHdl = args.frameId;
        let   stackFrame    = this._dbgState.stackFrames.get( stackFrameHdl );
        
        // Prepare DukScope objects
        const names     = [ "Local", "Closure", "Global" ];
        let   dukScopes = new Array<DukScope>(3);
        
        for( let i=0; i < names.length; i++ )
        {
            let scope    = new DukScope( names[i], stackFrame, null );
            scope.handle = this._dbgState.scopes.create( scope );
            
            dukScopes[i] = scope;
        }
        stackFrame.scopes = dukScopes;
        
        // Ask Duktape for the scope property keys for this stack frame
        var scopes:Scope[] = [];
        
        this._dukProto.requestClosures( stackFrame.depth )
        .then( ( r:DukGetClosureResponse ) => {
        
            let keys = [ r.local, r.closure, r.global ];
            let propPromises:Promise<PropertySet>[] = [];
            
            // Append 'this' to local scope, if it's not global
            return this.isGlobalObjectByName( "this", stackFrame.depth)
            .then( (isGlobal:boolean ) => {
                
                if( !isGlobal )
                    r.local.unshift( "this" );
                    
                // Create a PropertySet from each scope
                for( let i=0; i < names.length; i++ )
                {
                    if( keys[i].length == 0 )
                        continue;
                    
                    propPromises.push( this.expandScopeProperties( keys[i], dukScopes[i] ) );
                }
                
                if( propPromises.length > 0 )
                {
                    return Promise.all( propPromises ).then( (results:PropertySet[]) => {
                        
                        for( let i=0; i < results.length; i++ )
                            scopes.push( new Scope( results[i].scope.name, 
                                         results[i].handle, results[i].scope.name == "Global" ) );
                    });
                }
            });
        })
        .then( () => {
            response.body = { scopes: scopes };
            this.sendResponse( response );
        })
        .catch( err => {
            
            this.logToClient( "scopesRequest failed: " + err );
            response.body = { scopes: [] };
            this.sendResponse( response );
        });
    }
    
    //-----------------------------------------------------------
    protected variablesRequest( response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments ): void
    {
        this.logToClient( "[FE] variablesRequest" );
        
        assert( args.variablesReference != 0 );
        
        var properties = this._dbgState.varHandles.get( args.variablesReference );
        
        if( !properties )
        {
            // If a stop event happened, we may have cleared the state.
            response.body = { variables: [] };
            this.sendResponse( response );
            return;
            
            // TODO: Handle only one request from the front end at a time,
            // and perhaps cancel any pending if the state changed/cleared
        }
        
        var scope      = properties.scope;
        var stackFrame = scope.stackFrame;
        
        // Determine the property set reference type
        if( properties.type == PropertySetType.Scope )
        {
            // Scope-level variables are resolved at the time of the Scope request
            // just return the variables array
            response.body = { variables: scope.properties.variables };
            this.sendResponse( response );
            
            return;
        }
        else if( properties.type >= PropertySetType.Object )
        {
            // Resolve object sub-properties
            this.expandPropertySubset( properties ).then( objVars => {
                
                response.body = { variables: objVars };
                this.sendResponse( response ) ;
            });
        }
    }
    
    //-----------------------------------------------------------
    protected evaluateRequest( response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments ): void
    {
        this.logToClient( "evaluateRequest" );
        
        let x = args.expression;
        if( x.indexOf( "cmd:") == 0 )
        {
            let cmd    = x.substr( "cmd:".length );
            let result = "";
            
            switch( cmd )
            {
                default :
                    this.requestFailedResponse( response, "Unknown command: " + cmd );
                return;
                
                case "breakpoints" :
                {
                    this._dukProto.requestListBreakpoints()
                        .then( resp => {
                            
                            let r = <DukListBreakResponse>resp;
                            this.logToClient( "Breakpoints: " + r.breakpoints.length );
                            for( let i = 0; i < r.breakpoints.length; i++ )
                            {
                                let bp   = r.breakpoints[i];
                                let line = ( "[" + i + "] " + bp.fileName + ": " + bp.line );
                                
                                this.logToClient( line );  
                                result += ( line + "\n" );
                            }
                            
                        }).catch( err => {
                            this.requestFailedResponse( response, "Failed: " + err );
                        });
                }
                break;
            }
            
            response.body = {
                result: result,
                variablesReference: 0
            };
            
            this.sendResponse( response );
        }
        else
        {
            let frame = this._dbgState.stackFrames.get( args.frameId );
            if( !frame )
                this.requestFailedResponse( response, "Failed to find stack frame: " + args.frameId );
                
            this._dukProto.requestEval( args.expression, frame.depth )
                .then( resp => {
                    
                    let r = <DukEvalResponse>resp;
                    if( !r.success )
                        this.requestFailedResponse( response, "Failed to find stack frame: " + args.frameId );    
                    else
                    {
                        response.body = {
                            result: String( r.result ),
                            variablesReference: frame.scopes[0].properties.handle
                        };
                        this.sendResponse( response );    
                    }
                    
                }).catch( err =>{
                    this.requestFailedResponse( response, "Failed to find stack frame: " + args.frameId );
                });
                
            return;
        }
        
    }

    /// Private
    
    //-----------------------------------------------------------
    // Clear all breakpoints for a source file
    private clearBreakPoints( src:SourceFile ) : Promise<any>
    {
        if( src.breakpoints.length < 1 )
            return Promise.resolve();
        
        // TODO: Check a flag on the source file to see if it's busy setting/removing
        // breakpoints? To make sure that no brakpoint attempts are done while working
        // on a request still?
        
        var bpList = src.breakpoints;
        src.breakpoints = new Array<DukBreakPoint>();
                
        var pcontext = { resolve: undefined, reject: undefined };
        
        let cb = ( resolve, reject ) =>
        {
            pcontext.resolve = resolve;
            pcontext.reject  = reject;
        };
        
        var p = new Promise<any>( cb );
        
        var removeBP = ( i:number ) => {
            
            try {
                this._dukProto.requestRemoveBreakpoint( bpList[i].dukIdx )
                .then().catch( (err) =>{})
                    .then( () => {      // Ignore result
                        
                        i --;
                        if( i > -1 )
                            removeBP( i );      // Go to the next one
                        else
                            pcontext.resolve(); // Done
                });
            }
            catch( err )
            {
                this.logToClient( "an error " + err);
            }
        };
        
        // Duk keeps an index-based breakpoints,
        // so we must start from the top-most,
        // otherwise we'll end-up with invalid breakpoint indices
        removeBP( bpList.length-1 );
        
        return p;
    }
    
    //-----------------------------------------------------------
    private removeAllTargetBreakpoints() : Promise<any>
    {
        this.logToClient( "removeAllTargetBreakpoints" );
        
        var numBreakpoints:number = 0;
        
        return this._dukProto.requestListBreakpoints()
            .then( resp => {
                
                let r = <DukListBreakResponse>resp;
                
                numBreakpoints = r.breakpoints.length;
                
                if( numBreakpoints < 1 )
                    return Promise.resolve();
                
                var promises = new Array<Promise<any>>();
                promises.length = numBreakpoints;
                
                numBreakpoints --; // Make it zero based
                
                // Duktape's breakpoints are tightly packed and index based,
                // so just remove them each from the top down
                for( let i=numBreakpoints; i >= 0; i-- )
                    promises[i] = this._dukProto.requestRemoveBreakpoint( numBreakpoints-- );
                    
                return Promise.all( promises );
            } );
    }
    
    //-----------------------------------------------------------
    // Obtains all variables for the specificed scope. 
    // It creates a PropertySet for that scope and 
    // resolves pointers to object types in that scope.
    // It returns a PropertySet with the variables array resolved and
    // ready to be sent to the front end.
    //-----------------------------------------------------------
    private expandScopeProperties( keys:string[], scope:DukScope ) : Promise<PropertySet>
    {
        var propSet = new PropertySet( "", PropertySetType.Scope );
        propSet.handle    = this._dbgState.varHandles.create( propSet );
        propSet.scope     = scope;
        propSet.variables = [];
        
        scope.properties = propSet;
        
        // Eval all the keys to get the values
        let evalPromises = new Array<Promise<any>>( keys.length );
        
        for( let i=0; i < keys.length; i++ )
            evalPromises[i] = this._dukProto.requestEval( keys[i], scope.stackFrame.depth ); 
        
        return Promise.all( evalPromises )
        .then( (results:DukEvalResponse[]) => {
         
            let ctorPromises:Promise<string>[] = [];    // If we find objects values, get their constructors.
            let objVars     :Variable[]        = [];    // Save object vars separate to set the value
                                                        //  when the constructor promise returns
                                                        
            // Split into key value pairs, filtering out failed evals
            let pKeys:string[]            = [];
            let pValues:Duk.DValueUnion[] = [];
            
            for( let i = 0; i < results.length; i++ )
            {
                if( !results[i].success )
                    continue;
             
                pKeys.push( keys[i] );
                pValues.push( results[i].result );
            }
            
            if( pKeys.length < 1 )
                return propSet;
            
            return this.resolvePropertySetVariables( pKeys, pValues, propSet );
            
        })
        .catch( err => {
            return propSet;
        });
    }
    
    //-----------------------------------------------------------
    private expandPropertySubset( propSet:PropertySet ) : Promise<Variable[]>
    {
        if( propSet.type == PropertySetType.Object )
        {
            // Check if this object's properties have been expanded already
            // ( if the variables property is not undefined, it's been expanded )
            if( propSet.variables )
                return Promise.resolve( propSet.variables );
            
            propSet.variables = [];
            
            // Inspect the object
            return this._dukProto.requestInspectHeapObj( propSet.heapPtr )
            .then( ( r:DukGetHeapObjInfoResponse ) => {
                
                // Split into internal properties and object properties
                let numInternal = r.numInternalProps();
                let numProps    = r.properties.length - numInternal;
                
                let props        = r.properties.slice( numInternal, r.properties.length );
                
                
                // Create a property set for the internal properties
                let internals    = new PropertySet( "", PropertySetType.Internal );
                internals.handle = this._dbgState.varHandles.create( internals );
                internals.scope  = propSet.scope;
                
                // Convert internals to debugger Variable objets
                internals.variables = new Array<Variable>( numInternal );
                for( let i=0; i < numInternal; i++ )
                {
                    let p = r.properties[i];
                    internals.variables[i] = new Variable( <string>p.key, String(p.value), 0 );
                }
                
                // Add internal node to the property set
                propSet.variables.push( new Variable( "__internal", "{...}", internals.handle ) );
                
                // Get Property table
                if( numProps < 1 )
                    return propSet.variables;

                return this.resolvePropertySetVariables(
                    ArrayX.convert( props, (v) => String(v.key) ),
                    ArrayX.convert( props, (v) => v.value),
                    propSet )
                .then( (p) => propSet.variables );
                
            });
        }
        else if( propSet.type == PropertySetType.Internal )
        {
            return Promise.resolve( propSet.variables );
        }
        
        
        return Promise.resolve( [] );
    }
    
    //-----------------------------------------------------------
    private resolvePropertySetVariables( keys:string[], values:Duk.DValueUnion[], propSet:PropertySet ) : Promise<PropertySet>
    {
        let scope:DukScope = propSet.scope;
        
        let ctorPromises:Promise<string>[] = [];    // If we find objects values, get their constructors.
        let objVars     :Variable[]        = [];    // Save object vars separate to set the value
                                                    //  when the constructor promise returns
        
        if( !propSet.variables )
            propSet.variables = [];
        
        // Get all the variables ready
        for( let i = 0; i < keys.length; i++ )
        {
            let key   = keys[i];
            let value = values[i];
            
            let variable = new Variable( key, "", 0 );
            propSet.variables.push( variable );
            
            // If it's an object, create a sub property set
            if( value instanceof Duk.TValObject )
            {
                // Check if this object's pointer has already been cached
                let ptrStr     = ((<Duk.TValObject>value).ptr).toString();
                let objPropSet = this._dbgState.ptrHandles[ptrStr];
                 
                if( objPropSet )
                {
                    // Object already exists, refer to prop set handle
                    variable.variablesReference = objPropSet.handle;
                    
                    // NOTE: Existing prop sets might register themselves to 
                    // get the constructor name as well if the existing object 
                    // was registered on this very call
                    // (that existing variable is in the same object level as this one), 
                    // then it's 'ctrorName' field currently points to undefined.
                    if( objPropSet.ctorName )
                    {
                        variable.value = objPropSet.ctorName;
                        continue;
                    }
                }
                else
                {
                    // New object
                    objPropSet          = new PropertySet( key, PropertySetType.Object );
                    objPropSet.heapPtr  = (<Duk.TValObject>value).ptr;
                    objPropSet.scope    = scope;
                    
                    objPropSet.handle  = this._dbgState.varHandles.create( objPropSet );
                    variable.variablesReference = objPropSet.handle;
                    
                    // Register with the pointer map
                    this._dbgState.ptrHandles[ptrStr] = objPropSet;  
                }
                
                // Mark to request the constructor name
                ctorPromises.push( this.getObjectConstructorName( objPropSet.heapPtr ) );
                objVars.push( variable );
            }
            else
            {
                // Non-expandable value
                variable.value = typeof value === "string" ? `"${value}"` : String( value );
            }
        }
        
        // If we have any objects types, resolve their constructor names
        if( ctorPromises.length > 0 )
        {
            return Promise.all( ctorPromises )
            .then( (ctorNames:string[]) => {
                
                //let arrayTypes = [];
                
                for( let i=0; i < ctorNames.length; i++ )
                {
                    let ctor = ctorNames[i];
                    //if( ctor == "Array" )
                    //{
                    //    arrayTypes.push( objVars[i] );
                    //    ctor = ctor;
                    //}
                    this._dbgState.varHandles.get( objVars[i].variablesReference ).ctorName = ctor;
                    objVars[i].value = ctor;
                }
                
                // TODO: Support this. It's too costly right now to get the length by
                // querying all the properties.
                // Check if we have array types, in order to find their lengths
                /*
                if( arrayTypes.length > 0 )
                {
                    for( let i=0; i < arrayTypes.length; i++ )
                        this._dukProto.requestEval( )
                }
                else
                */
                    return Promise.resolve( propSet ); 
            });
        }
        else
            return Promise.resolve( propSet );
    }
    
    //-----------------------------------------------------------
    // Find the constructor name for a given heap pointer
    // Returns "{ Null }" when the pointer is null or
    // Object upon any failure
    //-----------------------------------------------------------
    private getObjectConstructorName( targetPtr:Duk.TValPointer ) : Promise<string>
    {
        if( targetPtr.isNull() )
            return Promise.resolve( "{ Null }" );
            
        return this._dukProto.requestInspectHeapObj( targetPtr, 0 )
        
        // Find proto type first
        .then( ( r:DukGetHeapObjInfoResponse ) => {
            
            let proto = ArrayX.firstOrNull( r.properties, (v) => v.key == "internal_prototype" );
            if( !proto )
                return Promise.reject( null );
                
             // Find constructor property
            return this._dukProto.requestInspectHeapObj( (<Duk.TValObject>proto.value).ptr, 0 )
            .then( ( r:DukGetHeapObjInfoResponse ) => {
                
                let ctorProp = ArrayX.firstOrNull( r.properties, (v) => v.key == "constructor" );
                if( !ctorProp )
                    return Promise.reject( null );
                    
                // Find name property
                return this._dukProto.requestInspectHeapObj( (<Duk.TValObject>ctorProp.value).ptr, 0 )
                .then( ( r:DukGetHeapObjInfoResponse ) => {
                    
                    let nameProp = ArrayX.firstOrNull( r.properties, (v) => v.key == "name" );
                    if( !nameProp )
                        return Promise.reject( null );
                    
                    return String( nameProp.value );
                });
            });
        })
        .catch( (err) => "Object" );
    }
    
    //-----------------------------------------------------------
    private getPropertyInfoForKey( name:string, stackDepth:number ) : Promise<any>
    {
                    let expression = 
`
(function(){
if( ${name} === undefined ) return JSON.stringify( { n:\"${name}\", t:"undefined", v:"undefined"} );
if( ${name} === null ) return JSON.stringify( { n:\"${name}\", t:"null", v:"null"} );
var v;
var t=typeof ${name};
if( Object.prototype.toString.call( ${name} ) === \"[object Array]\" ){
    t = \"array\";
    v = ${name}.length; }
else if( ${name} instanceof Object )
    v = ${name}.constructor.toString().match(/\\w+/g)[1];
else
    v = ${name};
return JSON.stringify( { n:\"${name}\",t:t,v:v } );
})();`; 

        try {
            return this._dukProto.requestEval( expression, stackDepth )
                .then( (r:DukEvalResponse) => {
                    
                    if( !r.success || !r.result || typeof r.result !== "string" )
                    {
                        // Don't reject the promise, just ignore this properties, some
                        // of the global properties have some internal name thing that,
                        // makes the result fail.
                        return { n: name, t:undefined, v:undefined };
                        //return Promise.reject( "Eval failed for property key " + name );
                    }
                        
                    let obj = JSON.parse( <string>r.result );
                        
                    // Make sure to unquote "undefined" & "null",
                    // It seems JSON.stirngify won't serialze undefined, so i have to quote it
                    if( obj.t === "undefined" ) obj.t = undefined;
                    else if( obj.t === "null" ) obj.t = null;
                    
                    if( obj.v === "undefined" ) obj.v = undefined;
                    else if( obj.v === "null" ) obj.v = null;
                    
                    return obj;
                    
                });
        } catch( err ) { return Promise.reject( err ); }
        
    }
    
    //-----------------------------------------------------------
    private getPropertyInfoForKeys( keys:string[], stackDepth:number ) : Promise<any>
    {
        let promises = new Array<Promise<any>>( keys.length );
        
        for( let i=0; i < keys.length; i++ ) 
            promises[i] = this.getPropertyInfoForKey( keys[i], stackDepth );
            
        return Promise.all( promises );
    }
    
    //-----------------------------------------------------------
    private propertySetToVariables( scope:DukScope, properties:PropertySet,
                                    propInfos:{ n:string, t:string, v:any }[] ) : Variable[]
    {
        assert( Object.prototype.toString.call( propInfos ) === "[object Array]" );
        
        let variables:Variable[] = [];
        variables.length = propInfos.length; 
        
        if( propInfos.length < 1 )
            return [];
            
        for( let i = 0; i < propInfos.length; i++ )
        {
            let p          = propInfos[i];
            let value      = "";
            let propHandle = 0;
            
            let isExpandable = ( p.t == "array" || p.t == "object" );
            
            if( p.t == "array" )
                value = `Array[${p.v}]`;     // v = length, for array types
            else if( p.t == "string" )
                value = `"${p.v}"`; 
            else
                value = p.v;
            
            if( isExpandable )
            {
                // This is an expandable type, create a sub-PropertySet for this property
                let subPrefix = properties.prefix == "" ? p.n :
                                    //properties.type == "object" ?  `${properties.prefix}.${p.n}` :
                                    `${properties.prefix}[\"${p.n}\"]`;
                                         
                let subProps     = new PropertySet( subPrefix, PropertySetType.Object );
                subProps.handle  = this._dbgState.varHandles.create( subProps );
                subProps.scope   = scope;
                
                propHandle = subProps.handle;
            }
            
            variables[i] = new Variable( p.n, String( value ), propHandle );
        }
        
        return variables;
    }
    
    //-----------------------------------------------------------
    // Returns the object constructor. If it's the global object,
    // or an error occurrs, then it return an empty string. 
    //-----------------------------------------------------------
    private getObjectConstructorByName( prefix:string, stackDepth:number ) : Promise<any>
    {
        let exp = "(" + prefix + '.constructor.toString().match(/\\w+/g)[1])';
        
        return this.isGlobalObjectByName( prefix, stackDepth )
        .then( isGlobal => {
            
            if( isGlobal )
                return  "";
            
            // Not global object, try to get the constructor name
            return this._dukProto.requestEval( exp, stackDepth )
            .then( resp => {
                let r = <DukEvalResponse>resp;
                return r.success ? String(r.result) : "";
            });
            
        }).catch( err => "" );
    }
    
    //-----------------------------------------------------------
    // Returns true if the target prefix evaluates to the global
    // object. It rejects upon failure.
    //-----------------------------------------------------------
    private isGlobalObjectByName( prefix:string, stackDepth:number ) : Promise<any>
    {
        let exp = "String(" + prefix + ")";
        
        return this._dukProto.requestEval( exp, stackDepth )
        .then(
             (resp) => {
                
                let r = <DukEvalResponse>resp;
                if( !r.success )
                    return Promise.reject( "failed" );
                else
                {
                    let isglob = <string>r.result === "[object global]" ? true : false;
                    return isglob;
                } 
            },
            
            ( err ) => { Promise.reject( err ) }
        );
    }

    //-----------------------------------------------------------
    private mapSourceFile( name:string ) : SourceFile
    {
        if( !name )
            return null;
        
        name = this.normPath( name );
        
        let sources = this._sources;
        
        // Attempt to find it first
        for( let k in sources )
        {
            let val:SourceFile = sources[k];
            if( val.name == name )
                return val;   
        }
        
        let path = this.normPath( Path.join( this._sourceRoot, name ) );
        if( !FS.existsSync( path ) )
            return null;
        
        let src:SourceFile = new SourceFile();
        src.id   = this._dbgState.nextSrcID ++;
        src.name = name;
        src.path = path;
        
        // Grab the source map, if it has any
        try { this.checkForSourceMap( src );
        } catch( err ){}
        
        sources[src.id] = src;
        return src;
    }
    
    //-----------------------------------------------------------
    private checkForSourceMap( src:SourceFile )
    {
        if( !this._args.sourceMaps )
            return;
            
        src.srcMapPath = this._sourceMaps.MapPathFromSource( src.path );
    }
    
    //-----------------------------------------------------------
    private getSourceNameByPath( path:string ) : string
    {
        path = this.normPath( path );
                
        if( path.indexOf( this._sourceRoot ) != 0 )
            return undefined;
        
        return path.substr( this._sourceRoot.length+1 );
    }

    //-----------------------------------------------------------
    private requestFailedResponse( response:DebugProtocol.Response, msg?:any ) : void
    {
        msg = msg ? msg.toString() : "";
        
        msg = "Request failed: " + msg; 
        this.logToClient( "ERROR: " + msg );
        this.sendErrorResponse( response, ErrorCode.RequestFailed, msg );
    }
    
    //-----------------------------------------------------------
    private logToClient( msg:string ) : void
    {
        this.sendEvent( new OutputEvent( msg + "\n" ) );
        
        console.log( msg );
    }
    
    //-----------------------------------------------------------
    private normPath( path:string ) : string
    {
        path = Path.normalize( path );
        path = path.replace(/\\/g, '/');
        return path;
    }

}

DebugSession.run( DukDebugSession );