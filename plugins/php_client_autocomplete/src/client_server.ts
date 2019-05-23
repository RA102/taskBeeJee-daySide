'use strict';

import { TextDocument } from 'vscode-languageserver';

import { TreeBuilder } from "./hvy/treeBuilder";
import { SuggestionBuilder } from './suggestionBuilder';
import { DefinitionProvider } from "./providers/definition";
import { Debug } from './util/Debug';

import { DocumentSymbolProvider } from "./providers/documentSymbol";

const util = require('util');

import "./plugin.ts"
declare var dayside: any;
declare var FileApi: any;

var filesDb = {
    initPromise: false,
    db: false,

    init: function () {
        var me = this;
        me.initPromise = new Promise(function(resolve,reject){
            var openRequest = window.indexedDB.open('dayside_php_autocomplete_'+location.href, 1);
            openRequest.onupgradeneeded = function (e:any) {
                e.target.result.createObjectStore("files", { keyPath: "path" });
            }
            openRequest.onsuccess = function(e:any) {
                me.db = e.target.result;
                resolve();
            };
        });
        
    },
    save: function (data) {
        var me = this;
        this.initPromise.then(function(){
            var transaction = me.db.transaction(["files"], "readwrite");
            var objectStore = transaction.objectStore("files");
            var request = objectStore.put(data);
            request.onerror = function (e) {
                console.debug("db error",e);
            }
        });
    },
    remove: function (path) {
        var me = this;
        this.initPromise.then(function(){
            var request = me.db.transaction(["files"], "readwrite").objectStore("files").delete(path);
        });
    },
    findAll: function () {
        var me = this;
        return new Promise(function(resolve,reject){
            me.initPromise.then(function(){
                var res = {};
                var objectStore = me.db.transaction("files").objectStore("files");
                objectStore.openCursor().onsuccess = function(event) {
                    var cursor = event.target.result;
                    if (cursor) {
                        res[cursor.key] = cursor.value;
                        cursor.continue();
                    } else {
                        resolve(res);
                    }
                };      
            });
        });
    }
}

var server = {
    treeBuilder: new TreeBuilder(),
    fileTree: {},
    connected: false,
    diffTimeout: false,
    initPromise: false,

    init: function () {
        var me = this;
        me.initPromise = new Promise(function(resolve,reject){
            filesDb.init();
            filesDb.findAll().then(function(res){
                me.fileTree = res;
                resolve();
            });
        });
    },

    connect: function () {
        this.connected = true;
        this.getFilesDiff();
    },

    disconnect: function () {
        clearTimeout(this.diffTimeout);
        this.connected = false;
    },

    getWorkspaceTree: function () {
        var nodes = [];
        for (var path in this.fileTree) {
            nodes.push(this.fileTree[path].node);
        }
        return nodes;
    },

    getFilesDiff: function () {
        var me = this;
        me.initPromise.then(function(){
            dayside.ready(function(){
                var checkHash = {};
                for (var path in me.fileTree) {
                    checkHash[path] = {
                        size: me.fileTree[path].size,
                        stamp: me.fileTree[path].stamp
                    }
                }
                FileApi.request('get_files_diff',{path:dayside.options.root,checkHash:JSON.stringify(checkHash)},true,function(ret){
                    console.debug("DIFF",ret.data);
                    for (var path in ret.data) {
                        var file = ret.data[path];
                        if (file) {
                            server.parseFile({
                                path: path,
                                size: file.size,
                                stamp: file.stamp,
                                text: file.text
                            });
                        } else {
                            filesDb.remove(path);
                            delete me.fileTree[path];
                        }
                    }

                    if (me.connected) {
                        me.diffTimeout = setTimeout(function(){
                            me.getFilesDiff();
                        },5000);
                    }
                });
            });
        });
    },

    parsingCallbacks: {},
    parsingState: {},

    parseFile: function (fileData) {
        var me = this;
        var path = fileData.path;

        me.parsingState[path] = me.parsingState[path] ? me.parsingState[path]+1 : 1;
        me.parsingCallbacks[path] = me.parsingCallbacks[path] || [];

        console.debug("PARSING",path.replace(dayside.options.root,""));

        this.treeBuilder.Parse(fileData.text, path).then(result => {
            var pre_obj = me.fileTree[path];
            var pre_stamp = pre_obj && pre_obj.stamp ? pre_obj.stamp : 0;
            var pre_size = pre_obj && pre_obj.size ? pre_obj.size : 0;

            var obj:any = {};
            obj.path = fileData.path;
            obj.node = result.tree;
            obj.stamp = fileData.stamp==undefined ? pre_stamp : fileData.stamp;
            obj.size = fileData.size==undefined ? pre_size : fileData.size;

            if (fileData.stamp && fileData.size) {
                if (obj.stableText==obj.text) {
                    obj.text = fileData.text;
                }
                obj.stableText = fileData.text;
            } else {
                obj.text = fileData.text;
                if (pre_obj && pre_obj.stableText) {
                    obj.stableText = pre_obj.stableText;
                }
            }

            me.fileTree[path] = obj;
            filesDb.save(obj);
            console.debug("DONE",obj.path.replace(dayside.options.root,""));

            me.parsingState[path]--;
            if (me.parsingState[path]<=0) {
                me.parsingCallbacks[path].forEach(function(cb){
                    cb.bind(me)();
                });
                delete me.parsingCallbacks[path];
                me.parsingState[path] = 0;
            }

            
        });
    },

    closeFile: function (path) {
        var me = this;
        me.fileTree[path].text = me.fileTree[path].stableText;
        me.parseFile(me.fileTree[path]);
    },

    completion: function (params,callback) {
        var me = this;
        var path = params.textDocument.uri;

        var doCompletion = function () {
            var suggestionBuilder = new SuggestionBuilder();
            var doc = <TextDocument>{
                getText: function () {
                    return me.fileTree[path].text;
                }
            }
            suggestionBuilder.prepare(params, doc, me.getWorkspaceTree());
            callback({
                result:{
                    items: suggestionBuilder.build()
                }
            })
        }
        
        if (me.parsingState[path]) {
            me.parsingCallbacks[path].push(doCompletion);
        } else {
            doCompletion();
        }
    },

    definition: function (params,callback) {
        let path = params.textDocument.uri;
        let filenode = this.fileTree[path].node;
        let definitionProvider = new DefinitionProvider(params, path, this.fileTree[path].text, filenode, this.getWorkspaceTree());
        callback({
            result: definitionProvider.findDefinition()
        });
    },

    documentSymbol: function (params,callback) {
        let path = params.textDocument.uri;
        let filenode = this.fileTree[path].node;
        let documentSymbolProvider = new DocumentSymbolProvider(filenode);
        callback({
            result: documentSymbolProvider.findSymbols()
        });
    }
};

server.init();
dayside.plugins.php_client_autocomplete.registerServer(server);
