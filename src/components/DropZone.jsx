import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, CheckCircle, AlertCircle, Link } from 'lucide-react';

const DropZone = ({ title, apps, onDrop, onRemove, connectionStatus = {}, onConnect }) => {
    const [isOver, setIsOver] = useState(false);

    const handleDragOver = (e) => {
        e.preventDefault();
        setIsOver(true);
    };

    const handleDragLeave = () => {
        setIsOver(false);
    };

    const handleDrop = (e) => {
        setIsOver(false);
        onDrop(e);
    };

    const handleConnect = (e, app) => {
        e.stopPropagation();
        const status = connectionStatus[app.id] || connectionStatus[app.name?.toLowerCase()];
        if (onConnect) {
            // Pass authUrl if available, or null if app needs config (has error)
            onConnect(app, status?.authUrl || null);
        }
    };

    const borderColor = isOver
        ? 'border-white'
        : 'border-white/10';

    const bgGradient = 'from-white/5 to-white/5';

    return (
        <div
            className={`flex-1 h-full rounded-2xl border-2 ${borderColor} bg-gradient-to-br ${bgGradient} backdrop-blur-sm transition-colors duration-300 flex flex-col overflow-hidden relative`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        >
            <div className="p-6 border-b border-white/5">
                <h2 className="text-2xl font-bold text-center text-white">
                    {title}
                </h2>
            </div>

            <div className="flex-1 p-6 overflow-y-auto custom-scrollbar">
                {apps.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-gray-500 border-2 border-dashed border-white/5 rounded-xl">
                        <p className="text-lg mb-2">Drag apps here</p>
                        <p className="text-sm opacity-50">Build your {title}</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-3 md:grid-cols-4 gap-4">
                        <AnimatePresence>
                            {apps.map((app) => {
                                const appKey = app.id || app.name?.toLowerCase();
                                const status = connectionStatus[appKey];
                                const isConnected = status?.connected === true;
                                const isChecking = status === undefined;
                                const requiresCustomModal = status?.requiresCustomModal; // Custom integration (like Frappe)

                                return (
                                    <motion.div
                                        key={app.id}
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        exit={{ opacity: 0 }}
                                        layout
                                        className="aspect-square rounded-xl bg-white/25 backdrop-blur-sm border border-white/30 flex flex-col items-center justify-center p-3 gap-2 hover:shadow-lg hover:bg-white/30 transition-all cursor-pointer relative group"
                                    >
                                        {/* Connection status indicator */}
                                        {!isChecking && (
                                            <div className="absolute top-1 left-1 z-10">
                                                {isConnected ? (
                                                    <CheckCircle className="w-5 h-5 text-green-400" title="Connected" />
                                                ) : (
                                                    <AlertCircle className="w-5 h-5 text-orange-400" title="Not connected" />
                                                )}
                                            </div>
                                        )}

                                        <img
                                            src={app.logo}
                                            alt={app.name}
                                            className="w-full h-full object-contain pointer-events-none"
                                            onError={(e) => {
                                                e.target.style.display = 'none';
                                                e.target.nextSibling.style.display = 'flex';
                                            }}
                                        />
                                        <div className="w-full h-full items-center justify-center text-gray-600 font-bold text-lg hidden pointer-events-none">
                                            {app.name?.charAt(0) || '?'}
                                        </div>

                                        {/* Connect button for disconnected apps */}
                                        {!isConnected && !isChecking && (
                                            <button
                                                onClick={(e) => handleConnect(e, app)}
                                                className="absolute bottom-1 left-1 right-1 py-1 px-2 bg-orange-500 hover:bg-orange-600 text-white text-xs font-medium rounded-lg flex items-center justify-center gap-1 transition-colors shadow-lg z-20"
                                                title={requiresCustomModal ? "Click to configure credentials" : "Choose how to connect"}
                                            >
                                                <Link className="w-3 h-3" />
                                                {requiresCustomModal ? 'Configure' : 'Connect'}
                                            </button>
                                        )}

                                        {/* Remove button on hover */}
                                        {onRemove && (
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    onRemove(app.id);
                                                }}
                                                className="absolute -top-2 -right-2 w-6 h-6 bg-red-500 hover:bg-red-600 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-lg z-20"
                                                title={`Remove ${app.name}`}
                                            >
                                                <X className="w-4 h-4 text-white" />
                                            </button>
                                        )}

                                        {/* Tooltip on hover in dropzone too */}
                                        <div className="absolute bottom-full mb-2 opacity-0 group-hover:opacity-100 transition-opacity bg-black/90 text-white text-xs py-1 px-2 rounded pointer-events-none whitespace-nowrap z-10">
                                            {app.name}
                                        </div>
                                    </motion.div>
                                );
                            })}
                        </AnimatePresence>
                    </div>
                )}
            </div>

            {/* Background Decoration */}
            <div className="absolute bottom-0 right-0 w-32 h-32 bg-white/5 blur-3xl rounded-full pointer-events-none" />
        </div>
    );
};

export default DropZone;
